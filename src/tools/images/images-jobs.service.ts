import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { join } from "path";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { STUDIO_IMAGE_FILENAME, resolveVideoImagesOutputDir } from "../videos/video-image.constants";
import { VideosImageService } from "../videos/videos-image.service";
import { GenerateStudioImageDto } from "./dto/generate-studio-image.dto";
import type { StudioImageJobQueuedResponse } from "./dto/studio-image-job-response.dto";
import { ImagesHistoryService } from "./images-history.service";

@Injectable()
export class ImagesJobsService {
  private readonly logger = new Logger(ImagesJobsService.name);

  constructor(
    private readonly videosImageService: VideosImageService,
    private readonly imagesHistoryService: ImagesHistoryService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {}

  async submitStudioImage(dto: GenerateStudioImageDto): Promise<StudioImageJobQueuedResponse> {
    const jobId = randomUUID();
    const userId = dto.userId.trim();
    this.logger.log(`[Image Studio] Nhận yêu cầu jobId=${jobId} userId=${userId}`);
    await this.imagesHistoryService.createPending(jobId, dto);
    void this.runStudioImage(jobId, userId, dto);
    return { jobId, status: "queued" };
  }

  private async runStudioImage(
    jobId: string,
    userId: string,
    dto: GenerateStudioImageDto,
  ): Promise<void> {
    const resultPath = join(resolveVideoImagesOutputDir(), userId, jobId, STUDIO_IMAGE_FILENAME);
    try {
      const result = await this.videosImageService.generateStudioImage(dto, jobId);
      await this.imagesHistoryService.markCompleted(jobId, resultPath);
      this.realtimeGateway.notifyUser(userId, "images.studio.completed", {
        jobId,
        result,
      });
      this.logger.log(`[Image Studio] Socket gửi images.studio.completed jobId=${jobId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.imagesHistoryService.markFailed(jobId, errorMessage);
      this.realtimeGateway.notifyUser(userId, "images.studio.failed", {
        jobId,
        errorMessage,
        terminal: true,
      });
      this.logger.warn(`[Image Studio] Socket gửi images.studio.failed jobId=${jobId} — ${errorMessage}`);
    }
  }
}
