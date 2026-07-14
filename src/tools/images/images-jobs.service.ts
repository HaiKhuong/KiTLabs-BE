import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { join } from "path";

import { NotificationsService } from "../notifications/notifications.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { STUDIO_IMAGE_FILENAME, resolveWorkflowImagesOutputDir } from "../workflow/workflow-image.constants";
import { WorkflowImageService } from "../workflow/workflow-image.service";
import { GenerateStudioImageDto } from "./dto/generate-studio-image.dto";
import type { StudioImageJobQueuedResponse } from "./dto/studio-image-job-response.dto";
import { ImagesHistoryService } from "./images-history.service";

@Injectable()
export class ImagesJobsService {
  private readonly logger = new Logger(ImagesJobsService.name);

  constructor(
    private readonly workflowImageService: WorkflowImageService,
    private readonly imagesHistoryService: ImagesHistoryService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
    private readonly notificationsService: NotificationsService,
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
    const resultPath = join(resolveWorkflowImagesOutputDir(), userId, jobId, STUDIO_IMAGE_FILENAME);
    try {
      const result = await this.workflowImageService.generateStudioImage(dto, jobId);
      await this.imagesHistoryService.markCompleted(jobId, resultPath, {
        enrichedPrompt: result.enrichedPrompt,
        geminiAnalysis: result.geminiAnalysis,
      });
      this.realtimeGateway.notifyUser(userId, "images.studio.completed", {
        jobId,
        result,
      });
      const promptPreview = dto.prompt.trim().slice(0, 80);
      await this.notificationsService.pushSuccess(
        userId,
        "Tạo ảnh hoàn tất",
        promptPreview
          ? `Ảnh đã sẵn sàng: “${promptPreview}${dto.prompt.trim().length > 80 ? "…" : ""}”.`
          : "Ảnh đã được tạo thành công.",
      );
      this.logger.log(`[Image Studio] Socket gửi images.studio.completed jobId=${jobId}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.imagesHistoryService.markFailed(jobId, errorMessage);
      this.realtimeGateway.notifyUser(userId, "images.studio.failed", {
        jobId,
        errorMessage,
        terminal: true,
      });
      await this.notificationsService.pushError(
        userId,
        "Tạo ảnh lỗi",
        errorMessage,
        "Không tạo được ảnh. Kiểm tra prompt / cấu hình và thử lại.",
      );
      this.logger.warn(`[Image Studio] Socket gửi images.studio.failed jobId=${jobId} — ${errorMessage}`);
    }
  }
}
