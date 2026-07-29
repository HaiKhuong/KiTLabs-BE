import { BadGatewayException, BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { GoogleGenAI } from "@google/genai";

import {
  GeminiKeyTier,
  geminiKeyPoolEnvHint,
  loadGeminiKeyPools,
  resolveGeminiKeyTier,
} from "../../common/gemini/gemini-key-pools";
import {
  GEMINI_IMAGE_ASPECT_RATIOS,
  GEMINI_IMAGE_MODELS,
  GEMINI_IMAGE_SIZES,
  GenerateGeminiImageDto,
  GeminiImageModel,
} from "./dto/generate-gemini-image.dto";

const DEFAULT_GEMINI_IMAGE_MODEL: GeminiImageModel = "gemini-3.1-flash-image";

@Injectable()
export class GeminiImageService {
  private readonly logger = new Logger(GeminiImageService.name);
  private readonly keyPools: Record<GeminiKeyTier, string[]>;
  private readonly keyIndexes: Record<GeminiKeyTier, number> = { normal: 0, vip: 0 };
  private readonly defaultModel: GeminiImageModel;

  constructor(private readonly config: ConfigService) {
    this.keyPools = loadGeminiKeyPools(config);
    this.defaultModel = this.resolveDefaultModel();
  }

  getCapabilities() {
    return {
      models: GEMINI_IMAGE_MODELS,
      defaultModel: this.defaultModel,
      aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
      defaultAspectRatio: "1:1",
      imageSizes: GEMINI_IMAGE_SIZES,
      defaultImageSize: "1K",
      outputMimeType: "image/jpeg",
      googleSearch: {
        supported: true,
        unsupportedModels: ["gemini-3.1-flash-lite-image"],
      },
      modelConstraints: {
        "gemini-3.1-flash-lite-image": {
          imageSizes: ["1K"],
          aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        },
        "gemini-3.1-flash-image": {
          imageSizes: ["512", "1K", "2K", "4K"],
          aspectRatios: GEMINI_IMAGE_ASPECT_RATIOS,
        },
        "gemini-3-pro-image": {
          imageSizes: ["1K", "2K", "4K"],
          aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"],
        },
      },
      apiKeyTiers: ["normal", "vip"],
      synthIdWatermark: true,
    };
  }

  async generate(dto: GenerateGeminiImageDto) {
    const model = dto.model ?? this.defaultModel;
    const imageSize = dto.imageSize ?? "1K";
    const aspectRatio = dto.aspectRatio ?? "1:1";
    this.validateRequest(model, imageSize, aspectRatio, dto.useGoogleSearch ?? false);

    const tier = resolveGeminiKeyTier(dto.apiKeyTier);
    const keys = this.keysForTier(tier);
    let lastError: unknown;

    for (let attempt = 0; attempt < keys.length; attempt++) {
      const apiKey = this.nextApiKey(tier);
      try {
        const client = new GoogleGenAI({ apiKey });
        const interaction = await client.interactions.create({
          model,
          input: dto.prompt.trim(),
          tools: dto.useGoogleSearch ? [{ type: "google_search" }] : undefined,
          response_format: {
            type: "image",
            delivery: "inline",
            mime_type: "image/jpeg",
            aspect_ratio: aspectRatio,
            image_size: imageSize,
          },
        });

        const image = interaction.output_image;
        if (!image?.data) {
          throw new BadGatewayException("Gemini image response did not contain inline image data");
        }

        return {
          interactionId: interaction.id,
          model,
          apiKeyTier: tier,
          aspectRatio,
          imageSize,
          image: {
            mimeType: image.mime_type ?? "image/jpeg",
            data: image.data,
          },
        };
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error) || attempt === keys.length - 1) break;
        this.logger.warn(`Gemini image key failed; retrying with the next ${tier} key`);
      }
    }

    throw this.toHttpException(lastError);
  }

  private validateRequest(
    model: GeminiImageModel,
    imageSize: string,
    aspectRatio: string,
    useGoogleSearch: boolean,
  ): void {
    if (model === "gemini-3.1-flash-lite-image") {
      if (imageSize !== "1K") {
        throw new BadRequestException("gemini-3.1-flash-lite-image only supports 1K image size");
      }
      if (["1:4", "1:8", "4:1", "8:1"].includes(aspectRatio)) {
        throw new BadRequestException(`gemini-3.1-flash-lite-image does not support ${aspectRatio} aspect ratio`);
      }
      if (useGoogleSearch) {
        throw new BadRequestException("gemini-3.1-flash-lite-image does not support Google Search grounding");
      }
    }

    if (model === "gemini-3-pro-image") {
      if (imageSize === "512") {
        throw new BadRequestException("gemini-3-pro-image does not support 512 image size");
      }
      if (["1:4", "1:8", "4:1", "8:1"].includes(aspectRatio)) {
        throw new BadRequestException(`gemini-3-pro-image does not support ${aspectRatio} aspect ratio`);
      }
    }
  }

  private keysForTier(tier: GeminiKeyTier): string[] {
    const keys = this.keyPools[tier];
    if (keys.length === 0) {
      throw new BadRequestException(`Gemini API key chưa cấu hình. Set ${geminiKeyPoolEnvHint(tier)} trong .env`);
    }
    return keys;
  }

  private nextApiKey(tier: GeminiKeyTier): string {
    const keys = this.keysForTier(tier);
    const index = this.keyIndexes[tier] % keys.length;
    this.keyIndexes[tier] = (index + 1) % keys.length;
    return keys[index];
  }

  private resolveDefaultModel(): GeminiImageModel {
    const configured = this.config.get<string>("GEMINI_IMAGE_DEFAULT_MODEL")?.trim();
    if (configured && (GEMINI_IMAGE_MODELS as readonly string[]).includes(configured)) {
      return configured as GeminiImageModel;
    }
    return DEFAULT_GEMINI_IMAGE_MODEL;
  }

  private isRetryable(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { status?: unknown; httpStatusCode?: unknown };
    const status = Number(value.status ?? value.httpStatusCode);
    return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
  }

  private toHttpException(error: unknown) {
    if (error instanceof BadRequestException || error instanceof BadGatewayException) {
      return error;
    }

    const value = error as {
      status?: unknown;
      httpStatusCode?: unknown;
      message?: unknown;
    };
    const status = Number(value?.status ?? value?.httpStatusCode);
    const providerMessage = typeof value?.message === "string" ? value.message : "Gemini image generation failed";

    this.logger.warn(`Gemini image generation failed: ${providerMessage}`);
    if (status >= 400 && status < 500) {
      return new BadRequestException({
        message: "Không thể tạo ảnh bằng Gemini",
        providerMessage,
        providerStatus: status,
      });
    }
    return new BadGatewayException({
      message: "Không thể tạo ảnh bằng Gemini",
      providerMessage,
      providerStatus: Number.isFinite(status) && status > 0 ? status : undefined,
    });
  }
}
