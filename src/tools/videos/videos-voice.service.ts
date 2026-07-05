import { BadRequestException, Injectable, Logger } from "@nestjs/common";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { AudioService } from "../audio/audio.service";
import { CreateAudioJobDto } from "../audio/dto/create-audio-job.dto";
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
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

@Injectable()
export class VideosVoiceService {
  private readonly logger = new Logger(VideosVoiceService.name);

  constructor(private readonly audioService: AudioService) {}

  private resolvePollTimeoutMs(): number {
    return Number(process.env.VIDEOS_VOICE_POLL_TIMEOUT_MS ?? 600_000);
  }

  private resolvePollIntervalMs(): number {
    return Number(process.env.VIDEOS_VOICE_POLL_INTERVAL_MS ?? 1_500);
  }

  private async waitForAudioJob(jobId: string): Promise<void> {
    const timeoutMs = this.resolvePollTimeoutMs();
    const intervalMs = this.resolvePollIntervalMs();
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const row = await this.audioService.getById(jobId);
      if (!row) {
        throw new Error(`Audio job not found: ${jobId}`);
      }
      if (row.status === QueueJobStatus.COMPLETED) return;
      if (row.status === QueueJobStatus.FAILED) {
        throw new Error(row.errorMessage?.trim() || "TTS failed");
      }
      await sleep(intervalMs);
    }

    throw new Error(`TTS timed out after ${timeoutMs}ms`);
  }

  private buildJobDto(dto: ExecuteVoiceDto, text: string): CreateAudioJobDto {
    const job: CreateAudioJobDto = {
      userId: dto.userId,
      text,
      voiceMode: dto.voiceMode,
      speed: dto.speed ?? 1,
      estimatedCost: 0,
    };

    if (dto.voiceMode === "preset") {
      job.voiceId = dto.voiceId;
    } else {
      job.pipelineRefWav = dto.pipelineRefWav;
      if (dto.cloneRefText?.trim()) {
        job.cloneRefText = dto.cloneRefText.trim();
      }
    }

    return job;
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
    const segments: VoiceSegmentResult[] = [];

    for (const scene of scenes) {
      try {
        const history = await this.audioService.enqueue(this.buildJobDto(dto, scene.voiceOver));
        await this.waitForAudioJob(history.id);
        const mapped = this.audioService.mapHistoryForClient(
          (await this.audioService.getById(history.id))!,
        );

        segments.push({
          sceneNumber: scene.sceneNumber,
          startTime: scene.startTime,
          endTime: scene.endTime,
          voiceOver: scene.voiceOver,
          jobId: history.id,
          status: "completed",
          playUrl: mapped.playUrl,
          downloadUrl: mapped.downloadUrl,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(`Voice TTS failed for scene ${scene.sceneNumber}: ${message}`);
        segments.push({
          sceneNumber: scene.sceneNumber,
          startTime: scene.startTime,
          endTime: scene.endTime,
          voiceOver: scene.voiceOver,
          jobId: null,
          status: "failed",
          playUrl: null,
          downloadUrl: null,
          errorMessage: message,
        });
      }
    }

    const failedCount = segments.filter((item) => item.status === "failed").length;
    if (failedCount === segments.length) {
      throw new BadRequestException(
        segments[0]?.errorMessage ?? "All voice segments failed",
      );
    }

    return {
      language,
      duration,
      voiceMode: dto.voiceMode,
      voiceId,
      segments,
    };
  }
}
