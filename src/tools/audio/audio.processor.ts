import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";

import { AUDIO_QUEUE_NAME, AudioService } from "./audio.service";

@Processor(AUDIO_QUEUE_NAME)
export class AudioProcessor extends WorkerHost {
  constructor(private readonly audioService: AudioService) {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.audioService.processFailed(audioHistoryId, message);
      throw error;
    }
  }
}
