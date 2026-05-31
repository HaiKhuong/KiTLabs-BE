import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { AUDIO_QUEUE_NAME, AudioService } from "./audio.service";

@Processor(AUDIO_QUEUE_NAME)
export class AudioProcessor extends WorkerHost {
  private readonly logger = new Logger(AudioProcessor.name);

  constructor(
    private readonly audioService: AudioService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<{ audioHistoryId: string }>): Promise<void> {
    const audioHistoryId = job.data?.audioHistoryId;
    if (!audioHistoryId) {
      throw new Error("audioHistoryId is required");
    }

    const history = await this.audioService.getById(audioHistoryId);
    if (!history) {
      throw new Error(`Audio history not found: ${audioHistoryId}`);
    }

    try {
      await this.audioService.processStarted(audioHistoryId);
      const resultPath = await this.audioService.runGeneration(history);
      await this.audioService.processCompleted(audioHistoryId, resultPath);

      const completed = await this.audioService.getById(audioHistoryId);
      const mapped = completed ? this.audioService.mapHistoryForClient(completed) : null;
      this.realtimeGateway.notifyUser(completed?.userId ?? "all", "audio.completed", {
        audioHistoryId,
        resultPath,
        resultFileName: mapped?.resultFileName ?? null,
        playUrl: mapped?.playUrl ?? null,
        downloadUrl: mapped?.downloadUrl ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = job.opts.attempts != null ? Number(job.opts.attempts) : 1;
      const attemptsMade = job.attemptsMade != null ? Number(job.attemptsMade) : 0;
      const willRetry = attemptsMade + 1 < maxAttempts;

      if (willRetry) {
        this.logger.warn(
          `Audio job ${job.id} failed (attempt ${attemptsMade + 1}/${maxAttempts}), will retry: ${message}`,
        );
        throw error;
      }

      await this.audioService.processFailed(audioHistoryId, message);
      const failed = await this.audioService.getById(audioHistoryId);
      this.realtimeGateway.notifyUser(failed?.userId ?? "all", "audio.failed", {
        audioHistoryId,
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }
}
