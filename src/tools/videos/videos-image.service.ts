import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios, { type AxiosInstance } from "axios";
import { randomInt, randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { GenerateStudioImageDto } from "../images/dto/generate-studio-image.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { RetrySceneImageDto } from "./dto/retry-scene-image.dto";
import {
  STUDIO_IMAGE_FILENAME,
  buildSceneImageRelativeUrl,
  buildStudioImageRelativeUrl,
  resolveComfyuiUrl,
  resolveImageModel,
  resolveModelWorkflowConfig,
  resolveModelWorkflowPath,
  resolveVideoImagesOutputDir,
} from "./video-image.constants";

type SceneRow = {
  sceneNumber: number;
  imagePrompt: string;
  imageNegativePrompt: string;
};

export type ImageSegmentResult = {
  sceneNumber: number;
  status: "completed" | "failed" | "skipped";
  imageUrl: string | null;
  downloadUrl: string | null;
  errorMessage?: string;
};

export type ExecuteImageResult = {
  style: string;
  aspectRatio: string;
  model: string;
  mode: string;
  images: ImageSegmentResult[];
  completedCount: number;
  failedCount: number;
};

export type StudioImageResult = {
  jobId: string;
  imageUrl: string;
  downloadUrl: string;
  model: string;
  style: string;
  aspectRatio: string;
  prompt: string;
  enrichedPrompt?: string;
  geminiAnalysis?: Record<string, unknown> | null;
};

type ComfyPromptResponse = {
  prompt_id: string;
  number: number;
  node_errors?: Record<string, unknown>;
  error?: string;
};

type ComfyHistoryOutput = {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
};

type ComfyHistoryEntry = {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<string, ComfyHistoryOutput>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toString(value: unknown): string {
  return typeof value === "string" ? value : value != null ? String(value) : "";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function previewLogText(text: string, max = 80): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "(empty)";
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`;
}

function parseScenesJson(raw: string): SceneRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new BadRequestException("scenes must be valid JSON");
  }

  let scenesRaw: unknown[] = [];
  if (Array.isArray(parsed)) {
    scenesRaw = parsed;
  } else {
    const root = asRecord(parsed);
    if (!root) {
      throw new BadRequestException("scenes JSON must be an object or array");
    }
    if (Array.isArray(root.scenes)) {
      scenesRaw = root.scenes;
    } else {
      const ideaField = asRecord(root.idea);
      if (ideaField && Array.isArray(ideaField.scenes)) {
        scenesRaw = ideaField.scenes;
      }
    }
  }

  const scenes: SceneRow[] = scenesRaw
    .map((item, index) => {
      const row = asRecord(item);
      if (!row) return null;
      const imagePrompt = toString(row.imagePrompt).trim();
      const visualDescription = toString(row.visualDescription).trim();
      const voiceOver = toString(row.voiceOver).trim();
      const prompt = imagePrompt || visualDescription || voiceOver;
      if (!prompt) return null;
      return {
        sceneNumber: toNumber(row.sceneNumber, index + 1),
        imagePrompt: prompt,
        imageNegativePrompt: toString(row.imageNegativePrompt).trim(),
      };
    })
    .filter((item): item is SceneRow => item !== null);

  if (scenes.length === 0) {
    throw new BadRequestException("No scenes with imagePrompt/visualDescription found in JSON");
  }

  return scenes;
}

function failedImage(scene: SceneRow, message: string): ImageSegmentResult {
  return {
    sceneNumber: scene.sceneNumber,
    status: "failed",
    imageUrl: null,
    downloadUrl: null,
    errorMessage: message,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Random 9-digit seed when user không truyền (vd. 845192736). */
function randomImageSeed(): number {
  return randomInt(100_000_000, 1_000_000_000);
}

function resolveImageSeed(seed?: number): number {
  if (seed != null && Number.isFinite(seed)) {
    return Math.trunc(seed);
  }
  return randomImageSeed();
}

function isRetryableComfyError(err: unknown): boolean {
  const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ENOTFOUND", "EAI_AGAIN"]);
  const RETRYABLE_MSGS = ["socket hang up", "network error", "client network socket disconnected"];

  if (axios.isAxiosError(err)) {
    const code = (err.code ?? "").toUpperCase();
    const msg = err.message.toLowerCase();
    return RETRYABLE_CODES.has(code) || RETRYABLE_MSGS.some((m) => msg.includes(m));
  }

  if (err instanceof Error) {
    const code = ((err as NodeJS.ErrnoException).code ?? "").toUpperCase();
    const msg = err.message.toLowerCase();
    return RETRYABLE_CODES.has(code) || RETRYABLE_MSGS.some((m) => msg.includes(m));
  }

  return false;
}

function historyHasOutputImages(entry: ComfyHistoryEntry | undefined): boolean {
  if (!entry?.outputs) return false;
  for (const nodeOutput of Object.values(entry.outputs)) {
    if (nodeOutput?.images?.length) return true;
  }
  return false;
}

function isHistoryComplete(entry: ComfyHistoryEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.status?.completed || entry.status?.status_str === "success") return true;
  return historyHasOutputImages(entry);
}

function resolveHistoryEntry(
  data: Record<string, ComfyHistoryEntry>,
  promptId: string,
): ComfyHistoryEntry | undefined {
  if (data[promptId]) return data[promptId];
  const keys = Object.keys(data);
  if (keys.length === 1) return data[keys[0]];
  return undefined;
}

@Injectable()
export class VideosImageService {
  private readonly logger = new Logger(VideosImageService.name);
  private comfyChain: Promise<unknown> = Promise.resolve();
  private workflowCache = new Map<string, Record<string, unknown>>();

  private getHttpClient(timeoutMs?: number): AxiosInstance {
    return axios.create({
      baseURL: resolveComfyuiUrl(),
      timeout: timeoutMs ?? Number(process.env.COMFYUI_REQUEST_TIMEOUT_MS ?? 30_000),
      headers: { Connection: "close" },
    });
  }

  private getPollRequestTimeoutMs(): number {
    return Number(process.env.COMFYUI_POLL_REQUEST_TIMEOUT_MS ?? 120_000);
  }

  private getTimeoutMs(): number {
    return Number(process.env.COMFYUI_TIMEOUT_MS ?? process.env.VIDEOS_IMAGE_CMD_TIMEOUT_MS ?? 300_000);
  }

  private getPollIntervalMs(): number {
    return Number(process.env.COMFYUI_POLL_INTERVAL_MS ?? 2_000);
  }

  private loadWorkflowTemplate(model: string): Record<string, unknown> {
    const modelId = resolveImageModel(model);
    const cached = this.workflowCache.get(modelId);
    if (cached) return JSON.parse(JSON.stringify(cached));

    const path = resolveModelWorkflowPath(modelId);
    if (!existsSync(path)) {
      throw new BadRequestException(`ComfyUI workflow not found for model "${modelId}": ${path}`);
    }
    const raw = readFileSync(path, "utf-8");
    const workflow = JSON.parse(raw) as Record<string, unknown>;
    this.workflowCache.set(modelId, workflow);
    this.logger.log(`[ComfyUI] Loaded workflow for model=${modelId}: ${path}`);
    return JSON.parse(JSON.stringify(workflow));
  }

  private aspectToSize(aspectRatio: string): { width: number; height: number } {
    const key = (aspectRatio || "9:16").trim();
    const mapping: Record<string, { width: number; height: number }> = {
      "9:16": { width: 768, height: 1344 },
      "16:9": { width: 1344, height: 768 },
      "1:1": { width: 1024, height: 1024 },
      "4:5": { width: 896, height: 1088 },
      "4:3": { width: 1152, height: 896 },
      "3:4": { width: 896, height: 1152 },
    };
    return mapping[key] ?? mapping["9:16"];
  }

  private buildWorkflow(
    model: string,
    options: {
      prompt: string;
      negativePrompt?: string;
      width: number;
      height: number;
      seed: number;
      steps?: number;
      filenamePrefix?: string;
    },
  ): Record<string, unknown> {
    const workflow = this.loadWorkflowTemplate(model);
    const { nodes } = resolveModelWorkflowConfig(model);
    const positiveNodeId = process.env.COMFYUI_POSITIVE_PROMPT_NODE_ID ?? nodes.positivePrompt;
    const negativeNodeId = process.env.COMFYUI_NEGATIVE_PROMPT_NODE_ID ?? nodes.negativePrompt;
    const latentNodeId = process.env.COMFYUI_LATENT_IMAGE_NODE_ID ?? nodes.latentImage;
    const samplerNodeId = process.env.COMFYUI_SAMPLER_NODE_ID ?? nodes.sampler;
    const saveNodeId = process.env.COMFYUI_SAVE_IMAGE_NODE_ID ?? nodes.saveImage;

    const positiveNode = asRecord(workflow[positiveNodeId]);
    if (positiveNode) {
      const inputs = asRecord(positiveNode.inputs) ?? {};
      inputs.text = options.prompt;
      positiveNode.inputs = inputs;
    }

    const negativeNode = asRecord(workflow[negativeNodeId]);
    if (negativeNode) {
      const inputs = asRecord(negativeNode.inputs) ?? {};
      inputs.text = options.negativePrompt ?? "";
      negativeNode.inputs = inputs;
    }

    const latentNode = asRecord(workflow[latentNodeId]);
    if (latentNode) {
      const inputs = asRecord(latentNode.inputs) ?? {};
      inputs.width = options.width;
      inputs.height = options.height;
      latentNode.inputs = inputs;
    }

    const samplerNode = asRecord(workflow[samplerNodeId]);
    if (samplerNode) {
      const inputs = asRecord(samplerNode.inputs) ?? {};
      inputs.seed = options.seed;
      if (options.steps != null) inputs.steps = options.steps;
      samplerNode.inputs = inputs;
    }

    if (options.filenamePrefix) {
      const saveNode = asRecord(workflow[saveNodeId]);
      if (saveNode) {
        const inputs = asRecord(saveNode.inputs) ?? {};
        inputs.filename_prefix = options.filenamePrefix;
        saveNode.inputs = inputs;
      }
    }

    return workflow;
  }

  private async submitPrompt(workflow: Record<string, unknown>): Promise<string> {
    const client = this.getHttpClient();
    const clientId = randomUUID();
    const { data } = await client.post<ComfyPromptResponse>("/prompt", {
      prompt: workflow,
      client_id: clientId,
    });

    if (data.error) {
      const nodeErrors = data.node_errors
        ? ` | node_errors: ${JSON.stringify(data.node_errors)}`
        : "";
      throw new Error(`ComfyUI rejected prompt: ${data.error}${nodeErrors}`);
    }

    return data.prompt_id;
  }

  private async waitForCompletion(promptId: string): Promise<ComfyHistoryEntry> {
    const client = this.getHttpClient(this.getPollRequestTimeoutMs());
    const timeoutMs = this.getTimeoutMs();
    const pollMs = this.getPollIntervalMs();
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 30;

    while (Date.now() < deadline) {
      const backoffMs = consecutiveErrors > 0
        ? Math.min(pollMs * Math.pow(1.5, Math.min(consecutiveErrors, 8)), 30_000)
        : pollMs;
      await sleep(backoffMs);
      pollCount += 1;
      try {
        const { data } = await client.get<Record<string, ComfyHistoryEntry>>(
          `/history/${promptId}`,
        );
        consecutiveErrors = 0;
        const entry = resolveHistoryEntry(data, promptId);
        if (isHistoryComplete(entry)) {
          this.logger.log(
            `[ComfyUI] prompt_id=${promptId} completed after ${pollCount} poll(s)`,
          );
          return entry!;
        }
        if (entry?.status?.status_str === "error") {
          throw new Error("ComfyUI execution failed — check ComfyUI server logs");
        }
      } catch (err) {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          consecutiveErrors = 0;
          continue;
        }
        if (isRetryableComfyError(err)) {
          consecutiveErrors += 1;
          if (consecutiveErrors <= 3 || consecutiveErrors % 10 === 0) {
            this.logger.warn(
              `[ComfyUI] poll transient error #${consecutiveErrors} (${errorMessage(err)}) prompt_id=${promptId} — retry in ${Math.round(backoffMs)}ms`,
            );
          }
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            throw new Error(
              `ComfyUI unreachable after ${consecutiveErrors} consecutive errors — prompt_id=${promptId}`,
            );
          }
          continue;
        }
        throw err;
      }
    }

    throw new Error(`ComfyUI timed out after ${timeoutMs}ms — prompt_id=${promptId}`);
  }

  private async downloadImage(
    filename: string,
    subfolder: string,
    type: string,
    outPath: string,
  ): Promise<void> {
    const client = this.getHttpClient(Number(process.env.COMFYUI_DOWNLOAD_TIMEOUT_MS ?? 120_000));
    const { data } = await client.get("/view", {
      params: { filename, subfolder, type },
      responseType: "arraybuffer",
    });
    const dir = dirname(outPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(outPath, Buffer.from(data));
  }

  private async downloadImageWithRetry(
    filename: string,
    subfolder: string,
    type: string,
    outPath: string,
  ): Promise<void> {
    const maxAttempts = Number(process.env.COMFYUI_DOWNLOAD_RETRIES ?? 3);
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await this.downloadImage(filename, subfolder, type, outPath);
        return;
      } catch (err) {
        lastError = err;
        if (!isRetryableComfyError(err) || attempt >= maxAttempts) {
          throw err;
        }
        this.logger.warn(
          `[ComfyUI] download retry ${attempt}/${maxAttempts} (${errorMessage(err)}) file=${filename}`,
        );
        await sleep(1_000 * attempt);
      }
    }

    throw lastError;
  }

  private findOutputImages(
    entry: ComfyHistoryEntry,
    model: string,
  ): Array<{ filename: string; subfolder: string; type: string }> {
    const outputs = entry.outputs ?? {};
    const images: Array<{ filename: string; subfolder: string; type: string }> = [];
    const { nodes } = resolveModelWorkflowConfig(model);
    const saveNodeId = process.env.COMFYUI_SAVE_IMAGE_NODE_ID ?? nodes.saveImage;
    const targetOutput = outputs[saveNodeId];
    if (targetOutput?.images) {
      images.push(...targetOutput.images);
    }

    if (images.length === 0) {
      for (const nodeOutput of Object.values(outputs)) {
        if (nodeOutput?.images) {
          images.push(...nodeOutput.images);
        }
      }
    }

    return images;
  }

  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.comfyChain.then(task);
    this.comfyChain = run.catch(() => undefined);
    return run;
  }

  private buildOutputDir(userId: string, nodeId: string): string {
    const dir = join(resolveVideoImagesOutputDir(), userId, nodeId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private removeStudioOutputIfEmpty(outPath: string): void {
    try {
      if (existsSync(outPath)) return;
      const dir = dirname(outPath);
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  private async generateSingleImage(options: {
    model: string;
    prompt: string;
    negativePrompt?: string;
    aspectRatio: string;
    style?: string;
    seed?: number;
    steps?: number;
    outPath: string;
    filenamePrefix?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    const model = resolveImageModel(options.model);
    const seed = resolveImageSeed(options.seed);
    const { width, height } = this.aspectToSize(options.aspectRatio);
    const fullPrompt = options.style
      ? `${options.prompt}, ${options.style} style`
      : options.prompt;

    const workflow = this.buildWorkflow(model, {
      prompt: fullPrompt,
      negativePrompt: options.negativePrompt,
      width,
      height,
      seed,
      steps: options.steps,
      filenamePrefix: options.filenamePrefix,
    });

    const promptId = await this.submitPrompt(workflow);
    this.logger.log(`[ComfyUI] model=${model} seed=${seed} prompt_id=${promptId}`);

    const entry = await this.waitForCompletion(promptId);
    const outputImages = this.findOutputImages(entry, model);

    if (outputImages.length === 0) {
      return { ok: false, error: "ComfyUI returned no output images" };
    }

    const img = outputImages[0];
    await this.downloadImageWithRetry(img.filename, img.subfolder, img.type, options.outPath);

    if (!existsSync(options.outPath)) {
      return { ok: false, error: "Downloaded image file is missing" };
    }

    return { ok: true };
  }

  async executeImage(
    dto: ExecuteImageDto,
    onSceneProgress?: (scene: ImageSegmentResult & { completedSoFar: number; totalScenes: number }) => void,
  ): Promise<ExecuteImageResult> {
    const mode = (dto.mode ?? "generate").trim().toLowerCase();
    if (mode !== "generate") {
      throw new BadRequestException(
        `Image mode "${mode}" chưa hỗ trợ — chỉ "generate" với ComfyUI`,
      );
    }

    const model = resolveImageModel(dto.model);
    const style = (dto.style ?? "cinematic").trim() || "cinematic";
    const aspectRatio = (dto.aspectRatio ?? "9:16").trim() || "9:16";
    const scenes = parseScenesJson(dto.scenes);
    const outputDir = this.buildOutputDir(dto.userId.trim(), dto.nodeId.trim());
    const runStartedAt = Date.now();

    const sceneJobs = scenes.map((scene) => ({
      scene,
      outPath: join(outputDir, `scene-${scene.sceneNumber}.png`),
    }));

    this.logger.log(
      `[Image] Nhận yêu cầu userId=${dto.userId.trim()} nodeId=${dto.nodeId.trim()} — ${scenes.length} scene, aspect=${aspectRatio}, style=${style}, model=${model}`,
    );

    const images: ImageSegmentResult[] = [];
    let completedCount = 0;
    let failedCount = 0;
    let consecutiveFails = 0;
    const MAX_CONSECUTIVE_FAILS = 3;

    for (const item of sceneJobs) {
      try {
        const result = await this.runExclusive(() =>
          this.generateSingleImage({
            model,
            prompt: item.scene.imagePrompt,
            negativePrompt: item.scene.imageNegativePrompt || undefined,
            aspectRatio,
            style,
            outPath: item.outPath,
            filenamePrefix: `scene-${item.scene.sceneNumber}`,
          }),
        );

        if (result.ok && existsSync(item.outPath)) {
          completedCount += 1;
          consecutiveFails = 0;
          const imageUrl = buildSceneImageRelativeUrl(
            dto.userId.trim(),
            dto.nodeId.trim(),
            item.scene.sceneNumber,
          );
          const segmentResult: ImageSegmentResult = {
            sceneNumber: item.scene.sceneNumber,
            status: "completed",
            imageUrl,
            downloadUrl: imageUrl,
          };
          images.push(segmentResult);
          onSceneProgress?.({ ...segmentResult, completedSoFar: completedCount + failedCount, totalScenes: sceneJobs.length });
        } else {
          failedCount += 1;
          consecutiveFails += 1;
          const segmentResult = failedImage(item.scene, result.error ?? "Image generation failed");
          images.push(segmentResult);
          onSceneProgress?.({ ...segmentResult, completedSoFar: completedCount + failedCount, totalScenes: sceneJobs.length });
        }
      } catch (err) {
        failedCount += 1;
        consecutiveFails += 1;
        const segmentResult = failedImage(item.scene, errorMessage(err));
        images.push(segmentResult);
        onSceneProgress?.({ ...segmentResult, completedSoFar: completedCount + failedCount, totalScenes: sceneJobs.length });
      }

      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        const reason = `Dừng sớm: ${consecutiveFails} scene liên tiếp thất bại — ComfyUI có thể không khả dụng`;
        this.logger.error(`[Image] ${reason} — nodeId=${dto.nodeId.trim()}`);
        for (const remaining of sceneJobs.slice(images.length)) {
          failedCount += 1;
          const segmentResult = failedImage(remaining.scene, reason);
          images.push(segmentResult);
          onSceneProgress?.({ ...segmentResult, completedSoFar: completedCount + failedCount, totalScenes: sceneJobs.length });
        }
        break;
      }
    }

    this.logger.log(
      `[Image] DONE (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) — OK ${completedCount}/${scenes.length}, lỗi ${failedCount}, nodeId=${dto.nodeId.trim()}`,
    );

    return {
      style,
      aspectRatio,
      model,
      mode,
      images,
      completedCount,
      failedCount,
    };
  }

  resolveImageFilePath(userId: string, nodeId: string, filename: string): string | null {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeName || safeName !== filename || !safeName.endsWith(".png")) {
      return null;
    }

    const candidate = join(resolveVideoImagesOutputDir(), userId, nodeId, safeName);
    return existsSync(candidate) ? candidate : null;
  }

  async generateStudioImage(dto: GenerateStudioImageDto, jobId?: string): Promise<StudioImageResult> {
    const prompt = dto.prompt.trim();
    if (!prompt) {
      throw new BadRequestException("prompt is required");
    }

    const userId = dto.userId.trim();
    const resolvedJobId = (jobId ?? randomUUID()).trim();
    const model = resolveImageModel(dto.model);
    const style = (dto.style ?? "anime").trim() || "anime";
    const aspectRatio = (dto.aspectRatio ?? "9:16").trim() || "9:16";
    const negativePrompt = (dto.negativePrompt ?? "").trim();
    const outputDir = this.buildOutputDir(userId, resolvedJobId);
    const outPath = join(outputDir, STUDIO_IMAGE_FILENAME);
    const runStartedAt = Date.now();

    this.logger.log(
      `[Image Studio] Xử lý jobId=${resolvedJobId} userId=${userId} — aspect=${aspectRatio}, style=${style}, model=${model}, prompt="${previewLogText(prompt)}"`,
    );

    try {
      const result = await this.runExclusive(() =>
        this.generateSingleImage({
          model,
          prompt,
          negativePrompt: negativePrompt || undefined,
          aspectRatio,
          style,
          seed: dto.seed,
          steps: dto.numInferenceSteps,
          outPath,
          filenamePrefix: `studio-${resolvedJobId.slice(0, 8)}`,
        }),
      );

      if (!result.ok || !existsSync(outPath)) {
        this.removeStudioOutputIfEmpty(outPath);
        const message = result.error ?? "Image generation failed";
        this.logger.error(
          `[Image Studio] DONE FAILED (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) jobId=${resolvedJobId} — ${message}`,
        );
        throw new BadRequestException(message);
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const message = errorMessage(err);
      this.removeStudioOutputIfEmpty(outPath);
      this.logger.error(
        `[Image Studio] DONE FAILED (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) jobId=${resolvedJobId} — ${message}`,
      );
      throw new BadRequestException(message);
    }

    const imageUrl = buildStudioImageRelativeUrl(userId, resolvedJobId);
    this.logger.log(
      `[Image Studio] DONE (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) jobId=${resolvedJobId} — ${imageUrl}`,
    );

    return {
      jobId: resolvedJobId,
      imageUrl,
      downloadUrl: imageUrl,
      model,
      style,
      aspectRatio,
      prompt,
    };
  }

  async retrySingleScene(dto: RetrySceneImageDto): Promise<ImageSegmentResult> {
    const userId = dto.userId.trim();
    const nodeId = dto.nodeId.trim();
    const model = resolveImageModel(dto.model);
    const style = (dto.style ?? "cinematic").trim() || "cinematic";
    const aspectRatio = (dto.aspectRatio ?? "9:16").trim() || "9:16";
    const outputDir = this.buildOutputDir(userId, nodeId);
    const outPath = join(outputDir, `scene-${dto.sceneNumber}.png`);

    this.logger.log(
      `[Image Retry] scene=${dto.sceneNumber} userId=${userId} nodeId=${nodeId} model=${model}`,
    );

    try {
      const result = await this.runExclusive(() =>
        this.generateSingleImage({
          model,
          prompt: dto.prompt,
          negativePrompt: dto.negativePrompt,
          aspectRatio,
          style,
          outPath,
          filenamePrefix: `scene-${dto.sceneNumber}`,
        }),
      );

      if (result.ok && existsSync(outPath)) {
        const imageUrl = buildSceneImageRelativeUrl(userId, nodeId, dto.sceneNumber);
        return {
          sceneNumber: dto.sceneNumber,
          status: "completed",
          imageUrl,
          downloadUrl: imageUrl,
        };
      }

      return {
        sceneNumber: dto.sceneNumber,
        status: "failed",
        imageUrl: null,
        downloadUrl: null,
        errorMessage: result.error ?? "Image generation failed",
      };
    } catch (err) {
      return {
        sceneNumber: dto.sceneNumber,
        status: "failed",
        imageUrl: null,
        downloadUrl: null,
        errorMessage: errorMessage(err),
      };
    }
  }
}
