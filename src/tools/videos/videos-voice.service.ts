import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";
import { randomUUID } from "crypto";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { AudioService } from "../audio/audio.service";
import { VIDEO_PIPELINE_DIR } from "../audio/audio.constants";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";

type SceneRow = {
  sceneNumber: number;
  startTime: number;
  endTime: number;
  voiceOver: string;
};

export type VoiceSegmentResult = {
  sceneNumber: number;
  startTime: number;
  endTime: number;
  voiceOver: string;
  jobId: string | null;
  status: "completed" | "failed" | "skipped";
  playUrl: string | null;
  downloadUrl: string | null;
  errorMessage?: string;
};

export type ExecuteVoiceResult = {
  language: string;
  duration: number;
  voiceMode: "preset" | "clone";
  voiceId: string;
  segments: VoiceSegmentResult[];
  completedCount: number;
  failedCount: number;
};

type SceneJob = {
  scene: SceneRow;
  jobId: string;
  outWav: string;
};

type PythonSegmentResult = {
  sceneNumber: number;
  ok: boolean;
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

function parseScenesJson(raw: string): {
  language: string;
  duration: number;
  scenes: SceneRow[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new BadRequestException("scenes must be valid JSON");
  }

  let scenesRaw: unknown[] = [];
  let language = "";
  let duration = 0;

  if (Array.isArray(parsed)) {
    scenesRaw = parsed;
  } else {
    const root = asRecord(parsed);
    if (!root) {
      throw new BadRequestException("scenes JSON must be an object or array");
    }
    language = toString(root.language);
    duration = toNumber(root.duration);
    if (Array.isArray(root.scenes)) {
      scenesRaw = root.scenes;
    } else {
      const ideaField = asRecord(root.idea);
      if (ideaField && Array.isArray(ideaField.scenes)) {
        scenesRaw = ideaField.scenes;
        language = language || toString(ideaField.language);
        duration = duration || toNumber(ideaField.duration);
      }
    }
  }

  const scenes: SceneRow[] = scenesRaw
    .map((item, index) => {
      const row = asRecord(item);
      if (!row) return null;
      const voiceOver = toString(row.voiceOver).trim();
      if (!voiceOver) return null;
      return {
        sceneNumber: toNumber(row.sceneNumber, index + 1),
        startTime: toNumber(row.startTime),
        endTime: toNumber(row.endTime),
        voiceOver,
      };
    })
    .filter((item): item is SceneRow => item !== null);

  if (scenes.length === 0) {
    throw new BadRequestException("No scenes with voiceOver found in JSON");
  }

  return { language, duration, scenes };
}

function failedSegment(scene: SceneRow, message: string, jobId: string | null = null): VoiceSegmentResult {
  return {
    sceneNumber: scene.sceneNumber,
    startTime: scene.startTime,
    endTime: scene.endTime,
    voiceOver: scene.voiceOver,
    jobId,
    status: "failed",
    playUrl: null,
    downloadUrl: null,
    errorMessage: message,
  };
}

@Injectable()
export class VideosVoiceService {
  private readonly logger = new Logger(VideosVoiceService.name);

  constructor(private readonly audioService: AudioService) {}

  private resolvePythonBin(): string {
    return (
      process.env.AUDIO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveCmdTimeoutMs(): number {
    return Number(process.env.VIDEOS_VOICE_CMD_TIMEOUT_MS ?? process.env.AUDIO_CMD_TIMEOUT_MS ?? 600_000);
  }

  private resolveVideoVoiceScript(): string {
    return resolve(process.cwd(), "tools/video-pipeline/video_voice_tts.py");
  }

  private async spawnVideoVoiceTts(payload: Record<string, unknown>): Promise<PythonSegmentResult[]> {
    const pythonBin = this.resolvePythonBin();
    const scriptPath = this.resolveVideoVoiceScript();
    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const timeoutMs = this.resolveCmdTimeoutMs();

    return new Promise((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [scriptPath], {
        cwd: scriptDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`Video voice TTS timed out after ${timeoutMs}ms`));
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
          rejectPromise(new Error(stderr.trim() || `video_voice_tts exited with code ${code}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout.trim()) as { segments?: PythonSegmentResult[] };
          resolvePromise(Array.isArray(parsed.segments) ? parsed.segments : []);
        } catch {
          rejectPromise(new Error(stderr.trim() || "Invalid JSON from video_voice_tts.py"));
        }
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });
  }

  async executeVoice(dto: ExecuteVoiceDto): Promise<ExecuteVoiceResult> {
    if (dto.voiceMode === "preset" && !dto.voiceId?.trim()) {
      throw new BadRequestException("voiceId is required for preset mode");
    }
    if (dto.voiceMode === "clone" && !dto.pipelineRefWav?.trim()) {
      throw new BadRequestException("pipelineRefWav is required for clone mode");
    }

    const { language, duration, scenes } = parseScenesJson(dto.scenes);
    const voiceId = dto.voiceMode === "preset" ? dto.voiceId!.trim() : dto.pipelineRefWav!.trim();
    const runStartedAt = Date.now();

    this.logger.log(
      `[Voice] Bắt đầu generate userId=${dto.userId} mode=${dto.voiceMode} voice=${voiceId} — ${scenes.length} scene (1 process Python)`,
    );

    const voiceRef = await this.audioService.resolveVideoVoiceReference(dto);
    const sceneJobs: SceneJob[] = [];

    for (const scene of scenes) {
      const jobId = randomUUID();
      const outWav = this.audioService.buildOutputPath(dto.userId, jobId);
      await this.audioService.createVideoVoiceHistory({
        id: jobId,
        userId: dto.userId,
        voiceMode: dto.voiceMode,
        voiceId: dto.voiceMode === "preset" ? dto.voiceId!.trim() : null,
        text: scene.voiceOver,
        refAudioPath: voiceRef.refAudioPath,
        refText: voiceRef.refText,
      });
      sceneJobs.push({ scene, jobId, outWav });
    }

    let pythonResults: PythonSegmentResult[] = [];
    try {
      pythonResults = await this.spawnVideoVoiceTts({
        ref_audio: voiceRef.refAudioPath,
        ref_text: voiceRef.refText,
        model_id: (process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim(),
        device_map: (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim() || "cuda:0",
        dtype_str: (process.env.OMNIVOICE_DTYPE ?? "float16").trim(),
        language: voiceRef.language,
        num_step: Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
        guidance_scale: Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
        scenes: sceneJobs.map((item) => ({
          sceneNumber: item.scene.sceneNumber,
          text: item.scene.voiceOver,
          out_wav: item.outWav,
        })),
      });
    } catch (err) {
      const message = errorMessage(err);
      this.logger.error(`[Voice] Python batch failed: ${message}`);
      for (const item of sceneJobs) {
        await this.audioService.failVideoVoiceHistory(item.jobId, message);
      }
      return {
        language,
        duration,
        voiceMode: dto.voiceMode,
        voiceId,
        segments: scenes.map((scene) => failedSegment(scene, message)),
        completedCount: 0,
        failedCount: scenes.length,
      };
    }

    const resultByScene = new Map(pythonResults.map((row) => [row.sceneNumber, row]));
    const segments: VoiceSegmentResult[] = [];
    let completedCount = 0;
    let failedCount = 0;

    for (const item of sceneJobs) {
      const outcome = resultByScene.get(item.scene.sceneNumber);
      if (outcome?.ok && existsSync(item.outWav)) {
        await this.audioService.completeVideoVoiceHistory(item.jobId, item.outWav);
        const mapped = this.audioService.mapHistoryForClient(
          (await this.audioService.getById(item.jobId))!,
        );
        completedCount += 1;
        segments.push({
          sceneNumber: item.scene.sceneNumber,
          startTime: item.scene.startTime,
          endTime: item.scene.endTime,
          voiceOver: item.scene.voiceOver,
          jobId: item.jobId,
          status: "completed",
          playUrl: mapped.playUrl,
          downloadUrl: mapped.downloadUrl,
        });
      } else {
        const message = outcome?.error?.trim() || "TTS failed";
        await this.audioService.failVideoVoiceHistory(item.jobId, message);
        failedCount += 1;
        segments.push(failedSegment(item.scene, message, item.jobId));
      }
    }

    segments.sort((a, b) => a.sceneNumber - b.sceneNumber);

    this.logger.log(
      `[Voice] Hoàn tất (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) — OK ${completedCount}/${scenes.length}, lỗi ${failedCount}`,
    );

    return {
      language,
      duration,
      voiceMode: dto.voiceMode,
      voiceId,
      segments,
      completedCount,
      failedCount,
    };
  }
}
