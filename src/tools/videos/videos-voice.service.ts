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
  completedCount: number;
  failedCount: number;
};

type PollResult =
  | { status: "completed" }
  | { status: "failed"; message: string };

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

function chunkScenes<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

type BatchProgress = {
  completed: number;
  failed: number;
  total: number;
};

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

  /** Số scene mỗi cụm TTS (1–10). Env VIDEOS_VOICE_BATCH_SIZE, mặc định 5. */
  private resolveBatchSize(override?: number): number {
    const fromDto = override != null && Number.isFinite(override) ? Math.floor(override) : 0;
    const fromEnv = Number(process.env.VIDEOS_VOICE_BATCH_SIZE ?? 5);
    const raw = fromDto > 0 ? fromDto : fromEnv;
    if (!Number.isFinite(raw)) return 5;
    return Math.min(10, Math.max(1, Math.floor(raw)));
  }

  private async processSceneBatch(
    dto: ExecuteVoiceDto,
    batchIndex: number,
    batchTotal: number,
    batch: SceneRow[],
    segments: VoiceSegmentResult[],
    progress: BatchProgress,
  ): Promise<void> {
    const batchNo = batchIndex + 1;
    const sceneNumbers = batch.map((scene) => scene.sceneNumber).join(", ");
    const doneBefore = progress.completed + progress.failed;
    const completedBefore = progress.completed;
    const failedBefore = progress.failed;
    const batchStartedAt = Date.now();

    this.logger.log(
      `[Voice] Cụm ${batchNo}/${batchTotal} — bắt đầu ${batch.length} scene [${sceneNumbers}] | tiến độ trước cụm: ${doneBefore}/${progress.total} (OK ${progress.completed}, lỗi ${progress.failed})`,
    );

    const queued: { scene: SceneRow; jobId: string }[] = [];

    for (const scene of batch) {
      try {
        const history = await this.audioService.enqueue(this.buildJobDto(dto, scene.voiceOver));
        queued.push({ scene, jobId: history.id });
        this.logger.debug(
          `[Voice] Cụm ${batchNo}/${batchTotal} enqueue scene ${scene.sceneNumber} → job ${history.id}`,
        );
      } catch (err) {
        const message = errorMessage(err);
        progress.failed += 1;
        this.logger.warn(
          `[Voice] Cụm ${batchNo}/${batchTotal} enqueue scene ${scene.sceneNumber} FAIL — đã xử lý ${progress.completed + progress.failed}/${progress.total}: ${message}`,
        );
        segments.push(failedSegment(scene, message));
      }
    }

    this.logger.log(
      `[Voice] Cụm ${batchNo}/${batchTotal} — đã enqueue ${queued.length}/${batch.length} job, chờ TTS…`,
    );

    for (const { scene, jobId } of queued) {
      const pollStarted = Date.now();
      const outcome = await this.pollAudioJob(jobId);
      const elapsedSec = ((Date.now() - pollStarted) / 1000).toFixed(1);

      if (outcome.status === "failed") {
        progress.failed += 1;
        this.logger.warn(
          `[Voice] Cụm ${batchNo}/${batchTotal} scene ${scene.sceneNumber} TTS FAIL (${elapsedSec}s) — đã generate ${progress.completed}/${progress.total}, lỗi ${progress.failed}: ${outcome.message}`,
        );
        segments.push(failedSegment(scene, outcome.message, jobId));
        continue;
      }

      const row = await this.audioService.getById(jobId);
      if (!row) {
        progress.failed += 1;
        this.logger.warn(
          `[Voice] Cụm ${batchNo}/${batchTotal} scene ${scene.sceneNumber} missing job sau complete — đã xử lý ${progress.completed + progress.failed}/${progress.total}`,
        );
        segments.push(failedSegment(scene, `Audio job not found after complete: ${jobId}`, jobId));
        continue;
      }

      const mapped = this.audioService.mapHistoryForClient(row);
      progress.completed += 1;
      this.logger.log(
        `[Voice] Cụm ${batchNo}/${batchTotal} scene ${scene.sceneNumber} OK (${elapsedSec}s) — đã generate ${progress.completed}/${progress.total}, lỗi ${progress.failed}`,
      );
      segments.push({
        sceneNumber: scene.sceneNumber,
        startTime: scene.startTime,
        endTime: scene.endTime,
        voiceOver: scene.voiceOver,
        jobId,
        status: "completed",
        playUrl: mapped.playUrl,
        downloadUrl: mapped.downloadUrl,
      });
    }

    this.logger.log(
      `[Voice] Cụm ${batchNo}/${batchTotal} xong (${((Date.now() - batchStartedAt) / 1000).toFixed(1)}s) — cụm này +${progress.completed - completedBefore} OK, +${progress.failed - failedBefore} lỗi | tổng đã generate ${progress.completed}/${progress.total}, lỗi ${progress.failed}`,
    );
  }

  /** Poll job — không throw, để caller tiếp tục scene khác. */
  private async pollAudioJob(jobId: string): Promise<PollResult> {
    const timeoutMs = this.resolvePollTimeoutMs();
    const intervalMs = this.resolvePollIntervalMs();
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
      const row = await this.audioService.getById(jobId);
      if (!row) {
        return { status: "failed", message: `Audio job not found: ${jobId}` };
      }
      if (row.status === QueueJobStatus.COMPLETED) {
        return { status: "completed" };
      }
      if (row.status === QueueJobStatus.FAILED) {
        return { status: "failed", message: row.errorMessage?.trim() || "TTS failed" };
      }
      await sleep(intervalMs);
    }

    return { status: "failed", message: `TTS timed out after ${timeoutMs}ms` };
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
    const batchSize = this.resolveBatchSize(dto.batchSize);
    const segments: VoiceSegmentResult[] = [];
    const batches = chunkScenes(scenes, batchSize);
    const progress: BatchProgress = {
      completed: 0,
      failed: 0,
      total: scenes.length,
    };
    const runStartedAt = Date.now();

    this.logger.log(
      `[Voice] Bắt đầu generate userId=${dto.userId} mode=${dto.voiceMode} voice=${voiceId} — ${scenes.length} scene, ${batches.length} cụm (tối đa ${batchSize}/cụm)`,
    );

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      await this.processSceneBatch(dto, index, batches.length, batch, segments, progress);
    }

    segments.sort((a, b) => a.sceneNumber - b.sceneNumber);

    const completedCount = progress.completed;
    const failedCount = progress.failed;

    this.logger.log(
      `[Voice] Hoàn tất (${((Date.now() - runStartedAt) / 1000).toFixed(1)}s) — đã generate ${completedCount}/${progress.total} voice, lỗi ${failedCount}`,
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
