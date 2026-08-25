import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import axios, { AxiosError } from "axios";

import {
  GeminiKeyTier,
  geminiKeyPoolEnvHint,
  loadGeminiKeyPools,
  resolveGeminiKeyTier,
} from "../../common/gemini/gemini-key-pools";
import { GenerateVeoVideoDto, VEO_MODELS, VeoInlineImageDto, VeoModel } from "./dto/generate-veo-video.dto";
import { buildVeoCapabilities } from "./veo-capabilities";
import { VideoHistoryService } from "./video-history.service";

type VeoOperationStatus = Record<string, unknown> & {
  name?: string;
  done?: boolean;
  error?: unknown;
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{
        video?: { uri?: string; mimeType?: string };
      }>;
    };
  };
};

type OperationContext = {
  apiKey: string;
  tier: GeminiKeyTier;
};

export type VeoVideoDownload = {
  stream: NodeJS.ReadableStream;
  contentType: string;
  contentLength?: string;
  fileName: string;
};

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

@Injectable()
export class GeminiVeoService implements OnModuleInit {
  private readonly logger = new Logger(GeminiVeoService.name);
  private readonly keyPools: Record<GeminiKeyTier, string[]>;
  private readonly keyIndexes: Record<GeminiKeyTier, number> = { normal: 0, vip: 0 };
  private readonly operationContexts = new Map<string, OperationContext>();
  private readonly defaultModel: VeoModel;

  constructor(
    private readonly config: ConfigService,
    private readonly videoHistoryService: VideoHistoryService,
  ) {
    this.keyPools = loadGeminiKeyPools(config);
    this.defaultModel = this.resolveDefaultModel();
  }

  async onModuleInit(): Promise<void> {
    const running = await this.videoHistoryService.getRunningOperations();
    for (const item of running) {
      this.startTracking(item.operationName, item.apiKeyTier);
    }
  }

  getCapabilities() {
    return buildVeoCapabilities(this.defaultModel);
  }

  async generate(dto: GenerateVeoVideoDto) {
    this.validateRequest(dto);

    const model = dto.model ?? this.defaultModel;
    const history = await this.videoHistoryService.createPending(dto, model);

    try {
      const tier = resolveGeminiKeyTier(dto.apiKeyTier);
      const apiKey = this.nextApiKey(tier);
      const client = new GoogleGenAI({ apiKey });
      const operation = await client.models.generateVideos({
        model,
        prompt: dto.prompt.trim(),
        image: dto.firstFrame ? this.toSdkImage(dto.firstFrame) : undefined,
        video: dto.extendVideo
          ? {
              uri: dto.extendVideo.uri,
              mimeType: dto.extendVideo.mimeType ?? "video/mp4",
            }
          : undefined,
        config: {
          aspectRatio: dto.aspectRatio ?? "16:9",
          durationSeconds: dto.durationSeconds ?? 8,
          resolution: dto.resolution ?? "720p",
          personGeneration: dto.personGeneration,
          seed: dto.seed,
          lastFrame: dto.lastFrame ? this.toSdkImage(dto.lastFrame) : undefined,
          referenceImages: dto.referenceImages?.map((image) => ({
            image: this.toSdkImage(image),
            referenceType: VideoGenerationReferenceType.ASSET,
          })),
        },
      });

      if (!operation.name) {
        throw new BadGatewayException("Gemini Veo did not return an operation name");
      }

      this.operationContexts.set(operation.name, { apiKey, tier });
      await this.videoHistoryService.markRunning(history.id, operation.name, tier);
      this.startTracking(operation.name, tier);
      this.logger.log(`Veo operation queued: ${operation.name} (${model}, ${tier})`);
      return {
        historyId: history.id,
        operationName: operation.name,
        done: operation.done ?? false,
        model,
        apiKeyTier: tier,
      };
    } catch (error) {
      await this.videoHistoryService.markFailed(history.id, error);
      throw this.toHttpException(error, "Không thể khởi tạo Gemini Veo operation");
    }
  }

  async getOperation(operationName: string, requestedTier?: string) {
    const { status, tier } = await this.fetchOperation(operationName, requestedTier);
    const resolvedOperationName = status.name ?? operationName;
    const video = status.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
    if (status.error) {
      await this.videoHistoryService.markFailedByOperation(resolvedOperationName, status.error);
    } else if (status.done && video?.uri) {
      await this.videoHistoryService.markCompletedByOperation(resolvedOperationName, {
        uri: video.uri,
        mimeType: video.mimeType,
      });
    } else if (status.done) {
      await this.videoHistoryService.markFailedByOperation(
        resolvedOperationName,
        "Gemini Veo completed without a generated video",
      );
    }
    return this.normalizeStatus({ ...status, name: resolvedOperationName }, tier);
  }

  async downloadGeneratedVideo(operationName: string, requestedTier?: string): Promise<VeoVideoDownload> {
    const { status, apiKey } = await this.fetchOperation(operationName, requestedTier);
    if (!status.done) {
      throw new BadRequestException("Veo operation is not completed yet");
    }
    if (status.error) {
      throw new BadGatewayException({
        message: "Gemini Veo generation failed",
        operationName,
        error: status.error,
      });
    }

    const video = status.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
    if (!video?.uri) {
      throw new NotFoundException("Generated video URI was not found in the Veo operation");
    }

    try {
      const response = await axios.get<NodeJS.ReadableStream>(video.uri, {
        headers: { "x-goog-api-key": apiKey },
        responseType: "stream",
        timeout: Number(this.config.get<string>("VEO_DOWNLOAD_TIMEOUT_MS") ?? 300_000),
        maxRedirects: 5,
      });
      const contentLength = response.headers["content-length"];
      return {
        stream: response.data,
        contentType: response.headers["content-type"] ?? video.mimeType ?? "video/mp4",
        contentLength: typeof contentLength === "string" ? contentLength : undefined,
        fileName: `veo-${this.operationId(operationName)}.mp4`,
      };
    } catch (error) {
      throw this.toHttpException(error, "Không thể tải video Gemini Veo");
    }
  }

  private validateRequest(dto: GenerateVeoVideoDto): void {
    const model = dto.model ?? this.defaultModel;
    const duration = dto.durationSeconds ?? 8;
    const resolution = dto.resolution ?? "720p";
    const hasReferences = (dto.referenceImages?.length ?? 0) > 0;
    const hasFirstFrame = dto.firstFrame != null;
    const isExtension = dto.extendVideo != null;
    const isImageBased = hasFirstFrame || hasReferences;

    if (dto.lastFrame && !hasFirstFrame) {
      throw new BadRequestException("lastFrame requires firstFrame");
    }
    if (hasReferences && hasFirstFrame) {
      throw new BadRequestException("referenceImages cannot be combined with firstFrame");
    }
    if (isExtension && (hasFirstFrame || dto.lastFrame || hasReferences)) {
      throw new BadRequestException("extendVideo cannot be combined with firstFrame, lastFrame, or referenceImages");
    }
    if ((hasReferences || isExtension || resolution === "1080p" || resolution === "4k") && duration !== 8) {
      throw new BadRequestException("durationSeconds must be 8 for reference images, extension, 1080p, or 4k");
    }
    if (isExtension && resolution !== "720p") {
      throw new BadRequestException("Video extension only supports 720p");
    }
    if (model === "veo-3.1-lite-generate-preview" && (hasReferences || isExtension)) {
      throw new BadRequestException("Veo 3.1 Lite does not support reference images or video extension");
    }
    if (model === "veo-3.1-lite-generate-preview" && resolution === "4k") {
      throw new BadRequestException("Veo 3.1 Lite does not support 4k resolution");
    }
    if (dto.personGeneration) {
      const expected = isImageBased ? "allow_adult" : "allow_all";
      if (dto.personGeneration !== expected) {
        throw new BadRequestException(
          `personGeneration must be "${expected}" for ${isImageBased ? "image-based" : "text/extension"} Veo 3.1 generation`,
        );
      }
    }
  }

  private resolveDefaultModel(): VeoModel {
    const configured = this.config.get<string>("VEO_DEFAULT_MODEL")?.trim();
    if (configured && (VEO_MODELS as readonly string[]).includes(configured)) {
      return configured as VeoModel;
    }
    return "veo-3.1-generate-preview";
  }

  private async trackOperation(operationName: string, tier: string): Promise<void> {
    const pollIntervalMs = Number(this.config.get<string>("VEO_BACKGROUND_POLL_INTERVAL_MS") ?? 10_000);
    const timeoutMs = Number(this.config.get<string>("VEO_BACKGROUND_TIMEOUT_MS") ?? 15 * 60_000);
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      try {
        const { status } = await this.fetchOperation(operationName, tier);
        const resolvedOperationName = status.name ?? operationName;
        const video = status.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
        if (status.error) {
          await this.videoHistoryService.markFailedByOperation(resolvedOperationName, status.error);
          return;
        }
        if (status.done && video?.uri) {
          await this.videoHistoryService.markCompletedByOperation(resolvedOperationName, {
            uri: video.uri,
            mimeType: video.mimeType,
          });
          return;
        }
        if (status.done) {
          await this.videoHistoryService.markFailedByOperation(
            resolvedOperationName,
            "Gemini Veo completed without a generated video",
          );
          return;
        }
      } catch (error) {
        this.logger.warn(
          `Background poll failed for ${operationName}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    await this.videoHistoryService.markFailedByOperation(
      operationName,
      `Gemini Veo operation timed out after ${Math.round(timeoutMs / 60_000)} minutes`,
    );
  }

  private startTracking(operationName: string, tier: string): void {
    void this.trackOperation(operationName, tier).catch((error) => {
      this.logger.error(
        `Veo background tracking stopped for ${operationName}`,
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  private toSdkImage(image: VeoInlineImageDto): { imageBytes: string; mimeType: string } {
    return { imageBytes: image.data, mimeType: image.mimeType };
  }

  private nextApiKey(tier: GeminiKeyTier): string {
    const keys = loadGeminiKeyPools(this.config)[tier];
    if (keys.length === 0) {
      throw new BadRequestException(`Gemini API key chưa cấu hình. Set ${geminiKeyPoolEnvHint(tier)} trong .env`);
    }
    const index = this.keyIndexes[tier] % keys.length;
    this.keyIndexes[tier] = (index + 1) % keys.length;
    return keys[index];
  }

  private async fetchOperation(
    operationNameInput: string,
    requestedTier?: string,
  ): Promise<{ status: VeoOperationStatus; apiKey: string; tier: GeminiKeyTier }> {
    const operationName = this.validateOperationName(operationNameInput);
    const remembered = this.operationContexts.get(operationName);
    const tier = remembered?.tier ?? resolveGeminiKeyTier(requestedTier);
    const candidates = [
      ...(remembered ? [remembered.apiKey] : []),
      ...loadGeminiKeyPools(this.config)[tier],
    ].filter((key, index, keys) => keys.indexOf(key) === index);

    if (candidates.length === 0) {
      throw new BadRequestException(`Gemini API key chưa cấu hình. Set ${geminiKeyPoolEnvHint(tier)} trong .env`);
    }

    let lastError: unknown;
    for (const apiKey of candidates) {
      try {
        const response = await axios.get<VeoOperationStatus>(`${GEMINI_API_BASE_URL}/${operationName}`, {
          headers: { "x-goog-api-key": apiKey },
          timeout: Number(this.config.get<string>("VEO_STATUS_TIMEOUT_MS") ?? 30_000),
        });
        this.operationContexts.set(operationName, { apiKey, tier });
        return { status: response.data, apiKey, tier };
      } catch (error) {
        lastError = error;
        const status = error instanceof AxiosError ? error.response?.status : undefined;
        if (status !== 403 && status !== 404) break;
      }
    }

    throw this.toHttpException(lastError, "Không thể lấy trạng thái Gemini Veo operation");
  }

  private normalizeStatus(status: VeoOperationStatus, tier: GeminiKeyTier) {
    const operationName = status.name ?? "";
    const video = status.response?.generateVideoResponse?.generatedSamples?.[0]?.video;
    const downloadQuery = new URLSearchParams({
      operationName,
      apiKeyTier: tier,
    }).toString();
    return {
      operationName,
      done: status.done ?? false,
      status: status.error ? "failed" : status.done ? "completed" : "processing",
      apiKeyTier: tier,
      error: status.error ?? null,
      video: video
        ? {
            uri: video.uri ?? null,
            mimeType: video.mimeType ?? "video/mp4",
            downloadUrl: `/api/tools/videos/veo/operations/video?${downloadQuery}`,
          }
        : null,
    };
  }

  private validateOperationName(value: string): string {
    const operationName = value?.trim();
    if (
      !operationName ||
      operationName.includes("..") ||
      operationName.includes("?") ||
      operationName.includes("#") ||
      !/^[A-Za-z0-9._~/-]+$/.test(operationName) ||
      !operationName.includes("/operations/")
    ) {
      throw new BadRequestException("Invalid Veo operationName");
    }
    return operationName;
  }

  private operationId(operationName: string): string {
    return (
      operationName
        .split("/")
        .pop()
        ?.replace(/[^A-Za-z0-9_-]/g, "") || "video"
    );
  }

  private toHttpException(error: unknown, fallback: string) {
    if (
      error instanceof BadRequestException ||
      error instanceof BadGatewayException ||
      error instanceof NotFoundException
    ) {
      return error;
    }

    const responseData = error instanceof AxiosError ? error.response?.data : undefined;
    const status = error instanceof AxiosError ? error.response?.status : undefined;
    const message =
      this.extractGoogleErrorMessage(responseData) ??
      (error instanceof Error ? error.message : String(error || fallback));

    this.logger.warn(`${fallback}: ${message}`);
    if (status && status >= 400 && status < 500) {
      return new BadRequestException({ message: fallback, providerMessage: message, providerStatus: status });
    }
    return new BadGatewayException({ message: fallback, providerMessage: message, providerStatus: status });
  }

  private extractGoogleErrorMessage(value: unknown): string | null {
    if (!value || typeof value !== "object") return null;
    const root = value as { error?: { message?: unknown }; message?: unknown };
    if (typeof root.error?.message === "string") return root.error.message;
    if (typeof root.message === "string") return root.message;
    return null;
  }
}
