import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { join, resolve } from "path";

import { VIDEO_PIPELINE_DIR } from "../audio/audio.constants";
import { GenerateStudioImageDto } from "../images/dto/generate-studio-image.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import {
  FLUX_SCHNELL_MODEL_ID,
  STUDIO_IMAGE_FILENAME,
  buildSceneImageRelativeUrl,
  buildStudioImageRelativeUrl,
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
};

type PythonImageResult = {
  sceneNumber: number;
  ok: boolean;
  path?: string;
  error?: string;
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

@Injectable()
export class VideosImageService {
  private readonly logger = new Logger(VideosImageService.name);

  private resolvePythonBin(): string {
    return (
      process.env.IMAGE_PYTHON_BIN ??
      process.env.AUDIO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveCmdTimeoutMs(): number {
    return Number(process.env.VIDEOS_IMAGE_CMD_TIMEOUT_MS ?? process.env.IMAGE_CMD_TIMEOUT_MS ?? 900_000);
  }

  private resolveFluxScript(): string {
    const raw = (process.env.IMAGE_PYTHON_SCRIPT ?? process.env.FLUX_PYTHON_SCRIPT ?? "").trim();
    if (raw) {
      return resolve(process.cwd(), raw);
    }
    return resolve(process.cwd(), "tools/video-pipeline/video_image_flux.py");
  }

  private resolveModelId(model?: string): string {
    const raw = (model ?? process.env.FLUX_MODEL_ID ?? FLUX_SCHNELL_MODEL_ID).trim();
    if (raw === "flux" || raw === "flux-schnell" || raw === "FLUX.1-schnell") {
      return FLUX_SCHNELL_MODEL_ID;
    }
    return raw || FLUX_SCHNELL_MODEL_ID;
  }

  private buildOutputDir(userId: string, nodeId: string): string {
    const dir = join(resolveVideoImagesOutputDir(), userId, nodeId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private async spawnFluxImageGen(payload: Record<string, unknown>): Promise<PythonImageResult[]> {
    const pythonBin = this.resolvePythonBin();
    const scriptPath = this.resolveFluxScript();
    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const timeoutMs = this.resolveCmdTimeoutMs();

    return new Promise((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [scriptPath], {
        cwd: scriptDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });

      let stdout = "";
      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`FLUX image generation timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
      });
      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        rejectPromise(err);
      });
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          rejectPromise(new Error(stderr.trim() || `video_image_flux exited with code ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { images?: PythonImageResult[] };
          resolvePromise(Array.isArray(parsed.images) ? parsed.images : []);
        } catch {
          rejectPromise(new Error(stderr.trim() || "Invalid JSON from video_image_flux.py"));
        }
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  async executeImage(dto: ExecuteImageDto): Promise<ExecuteImageResult> {
    const mode = (dto.mode ?? "generate").trim().toLowerCase();
    if (mode !== "generate") {
      throw new BadRequestException(`Image mode "${mode}" chưa hỗ trợ — chỉ "generate" với FLUX Schnell`);
    }

    const model = this.resolveModelId(dto.model);
    const style = (dto.style ?? "cinematic").trim() || "cinematic";
    const aspectRatio = (dto.aspectRatio ?? "9:16").trim() || "9:16";
    const scenes = parseScenesJson(dto.scenes);
    const outputDir = this.buildOutputDir(dto.userId.trim(), dto.nodeId.trim());
    const runStartedAt = Date.now();

    const sceneJobs = scenes.map((scene) => ({
      scene,
      outPath: join(outputDir, `scene-${scene.sceneNumber}.png`),
    }));

    let pythonResults: PythonImageResult[] = [];
    try {
      pythonResults = await this.spawnFluxImageGen({
        model_id: model,
        device_map: (process.env.FLUX_DEVICE_MAP ?? "").trim() || undefined,
        dtype_str: (process.env.FLUX_DTYPE ?? "bfloat16").trim(),
        guidance_scale: Number(process.env.FLUX_GUIDANCE_SCALE ?? 0),
        num_inference_steps: Number(process.env.FLUX_NUM_INFERENCE_STEPS ?? 4),
        max_sequence_length: Number(process.env.FLUX_MAX_SEQUENCE_LENGTH ?? 256),
        style,
        aspect_ratio: aspectRatio,
        scenes: sceneJobs.map((item) => ({
          sceneNumber: item.scene.sceneNumber,
          prompt: item.scene.imagePrompt,
          negative_prompt: item.scene.imageNegativePrompt || undefined,
          out_path: item.outPath,
        })),
      });
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`[Image] FLUX batch failed: ${message}`);
      return {
        style,
        aspectRatio,
        model,
        mode,
        images: scenes.map((scene) => failedImage(scene, message)),
        completedCount: 0,
        failedCount: scenes.length,
      };
    }

    const resultByScene = new Map(pythonResults.map((row) => [row.sceneNumber, row]));
    const images: ImageSegmentResult[] = [];
    let completedCount = 0;
    let failedCount = 0;

    for (const item of sceneJobs) {
      const outcome = resultByScene.get(item.scene.sceneNumber);
      if (outcome?.ok && existsSync(item.outPath)) {
        completedCount += 1;
        const imageUrl = buildSceneImageRelativeUrl(
          dto.userId.trim(),
          dto.nodeId.trim(),
          item.scene.sceneNumber,
        );
        images.push({
          sceneNumber: item.scene.sceneNumber,
          status: "completed",
          imageUrl,
          downloadUrl: imageUrl,
        });
      } else {
        failedCount += 1;
        images.push(
          failedImage(item.scene, outcome?.error?.trim() || "FLUX generation failed"),
        );
      }
    }

    this.logger.log(
      `[Image] Hoàn tất (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) — OK ${completedCount}/${scenes.length}, lỗi ${failedCount}`,
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

  async generateStudioImage(dto: GenerateStudioImageDto): Promise<StudioImageResult> {
    const prompt = dto.prompt.trim();
    if (!prompt) {
      throw new BadRequestException("prompt is required");
    }

    const userId = dto.userId.trim();
    const jobId = randomUUID();
    const model = this.resolveModelId(dto.model ?? "flux");
    const style = (dto.style ?? "cinematic").trim() || "cinematic";
    const aspectRatio = (dto.aspectRatio ?? "9:16").trim() || "9:16";
    const negativePrompt = (dto.negativePrompt ?? "").trim();
    const outputDir = this.buildOutputDir(userId, jobId);
    const outPath = join(outputDir, STUDIO_IMAGE_FILENAME);
    const numInferenceSteps =
      dto.numInferenceSteps ?? Number(process.env.FLUX_NUM_INFERENCE_STEPS ?? 4);
    const runStartedAt = Date.now();

    let pythonResults: PythonImageResult[] = [];
    try {
      pythonResults = await this.spawnFluxImageGen({
        model_id: model,
        device_map: (process.env.FLUX_DEVICE_MAP ?? "").trim() || undefined,
        dtype_str: (process.env.FLUX_DTYPE ?? "bfloat16").trim(),
        guidance_scale: Number(process.env.FLUX_GUIDANCE_SCALE ?? 0),
        num_inference_steps: numInferenceSteps,
        max_sequence_length: Number(process.env.FLUX_MAX_SEQUENCE_LENGTH ?? 256),
        seed: dto.seed,
        style,
        aspect_ratio: aspectRatio,
        scenes: [
          {
            sceneNumber: 1,
            prompt,
            negative_prompt: negativePrompt || undefined,
            out_path: outPath,
          },
        ],
      });
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`[Image Studio] FLUX failed: ${message}`);
      throw new BadRequestException(message);
    }

    const outcome = pythonResults.find((row) => row.sceneNumber === 1);
    if (!outcome?.ok || !existsSync(outPath)) {
      throw new BadRequestException(outcome?.error?.trim() || "FLUX generation failed");
    }

    const imageUrl = buildStudioImageRelativeUrl(userId, jobId);
    this.logger.log(
      `[Image Studio] Hoàn tất (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) — job ${jobId}`,
    );

    return {
      jobId,
      imageUrl,
      downloadUrl: imageUrl,
      model,
      style,
      aspectRatio,
      prompt,
    };
  }
}
