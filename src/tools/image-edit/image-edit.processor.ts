import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { IMAGE_EDIT_QUEUE_NAME } from "./image-edit.constants";
import { ImageEditHistoryService } from "./image-edit-history.service";
import { ImageEditService } from "./image-edit.service";

@Processor(IMAGE_EDIT_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: 30 * 60 * 1000,
  stalledInterval: 120_000,
  maxStalledCount: 1,
})
export class ImageEditProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageEditProcessor.name);

  constructor(
    private readonly imageEditService: ImageEditService,
    private readonly historyService: ImageEditHistoryService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {
    super();
  }

  async process(job: Job<{ historyId: string }>): Promise<void> {
    const historyId = job.data?.historyId;
    if (!historyId) {
      throw new UnrecoverableError("historyId is required");
    }

    try {
      const mapped = await this.imageEditService.runJob(historyId);
      const row = await this.historyService.getById(historyId);
      this.realtimeGateway.notifyUser(
        row?.userId ?? "all",
        "image-edit.completed",
        mapped as unknown as Record<string, unknown>,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `image-edit ${historyId} failed: ${message}`,
        error instanceof Error ? error.stack : undefined,
      );
      await this.historyService.markFailed(historyId, message);
      const row = await this.historyService.getById(historyId);
      this.realtimeGateway.notifyUser(row?.userId ?? "all", "image-edit.failed", {
        id: historyId,
        feature: row?.feature,
        errorMessage: message,
        terminal: true,
      });
      throw new UnrecoverableError(message);
    }
  }
}
