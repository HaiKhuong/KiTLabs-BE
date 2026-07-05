import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";

import { resolveAudioQueueLockDurationMs } from "./audio.constants";
import { AudioOmnivoiceRunner } from "./audio-omnivoice.runner";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { AUDIO_QUEUE_NAME, AudioService } from "./audio.service";

@Processor(AUDIO_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: resolveAudioQueueLockDurationMs(),
  stalledInterval: 120_000,
  maxStalledCount: 2,
})
export class AudioProcessor extends WorkerHost {
  private readonly logger = new Logger(AudioProcessor.name);

  constructor(
    private readonly audioService: AudioService,
    private readonly omnivoiceRunner: AudioOmnivoiceRunner,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<{ audioHistoryId: string }>): Promise<void> {
    const audioHistoryId = job.data?.audioHistoryId;
    if (!audioHistoryId) {
      throw new UnrecoverableError("audioHistoryId is required");
    }

    const history = await this.audioService.getById(audioHistoryId);
    if (!history) {
      throw new UnrecoverableError(`Audio history not found: ${audioHistoryId}`);
    }
    if (this.omnivoiceRunner.isCancelled(audioHistoryId)) {
      throw new UnrecoverableError(`Audio generation cancelled: ${audioHistoryId}`);
    }

    try {
      await this.audioService.processStarted(audioHistoryId);

      if (this.omnivoiceRunner.isCancelled(audioHistoryId)) {
        throw new UnrecoverableError(`Audio generation cancelled: ${audioHistoryId}`);
      }

      const plan = await this.audioService.buildGenerationPlan(history);
      this.logger.log(
        `Audio job ${job.id}: omnivoice_tts.py out=${plan.outPath.replace(/\\/g, "/")}`,
      );

      await this.omnivoiceRunner.execute(plan.payload, audioHistoryId);
      await this.audioService.processCompleted(audioHistoryId, plan.outPath);

      const completed = await this.audioService.getById(audioHistoryId);
      const mapped = completed ? this.audioService.mapHistoryForClient(completed) : null;
      this.realtimeGateway.notifyUser(completed?.userId ?? "all", "audio.completed", {
        audioHistoryId,
        resultPath: plan.outPath,
        resultFileName: mapped?.resultFileName ?? null,
        playUrl: mapped?.playUrl ?? null,
        downloadUrl: mapped?.downloadUrl ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = job.opts.attempts != null ? Number(job.opts.attempts) : 1;
      const attemptsMade = job.attemptsMade != null ? Number(job.attemptsMade) : 0;
      const isUnrecoverable =
        error instanceof UnrecoverableError || (error instanceof Error && error.name === "UnrecoverableError");
      const willRetry = !isUnrecoverable && attemptsMade + 1 < maxAttempts;

      if (willRetry) {
        this.logger.warn(
          `Audio job ${job.id} failed (attempt ${attemptsMade + 1}/${maxAttempts}), will retry: ${message}`,
        );
        throw error;
      }

      const stillExists = await this.audioService.getById(audioHistoryId);
      if (stillExists) {
        await this.audioService.processFailed(audioHistoryId, message);
        const failed = await this.audioService.getById(audioHistoryId);
        this.realtimeGateway.notifyUser(failed?.userId ?? "all", "audio.failed", {
          audioHistoryId,
          errorMessage: message,
          terminal: true,
        });
      } else {
        this.logger.warn(`Audio job ${job.id} finished after history ${audioHistoryId} was deleted`);
      }
      throw error;
    } finally {
      this.omnivoiceRunner.clearCancel(audioHistoryId);
    }
  }
}
