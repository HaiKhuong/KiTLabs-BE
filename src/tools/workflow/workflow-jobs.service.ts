import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import { RetrySceneImageDto } from "./dto/retry-scene-image.dto";
import type { WorkflowJobQueuedResponse } from "./dto/workflow-job-response.dto";
import { WorkflowAiService } from "./workflow-ai.service";
import { WorkflowImageService } from "./workflow-image.service";
import { WorkflowVoiceService } from "./workflow-voice.service";

export type WorkflowJobType = "ai_task" | "voice" | "image";

@Injectable()
export class WorkflowJobsService {
  private readonly logger = new Logger(WorkflowJobsService.name);

  constructor(
    private readonly workflowAiService: WorkflowAiService,
    private readonly workflowVoiceService: WorkflowVoiceService,
    private readonly workflowImageService: WorkflowImageService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {}

  submitAiTask(dto: ExecuteAiTaskDto): WorkflowJobQueuedResponse {
    const jobId = randomUUID();
    const nodeId = dto.nodeId!.trim();
    const userId = dto.userId!.trim();
    void this.runAiTask(jobId, userId, nodeId, dto);
    return { jobId, nodeId, type: "ai_task", status: "queued" };
  }

  submitVoice(dto: ExecuteVoiceDto): WorkflowJobQueuedResponse {
    const jobId = randomUUID();
    const nodeId = dto.nodeId.trim();
    const userId = dto.userId.trim();
    void this.runVoice(jobId, userId, nodeId, dto);
    return { jobId, nodeId, type: "voice", status: "queued" };
  }

  submitImage(dto: ExecuteImageDto): WorkflowJobQueuedResponse {
    const jobId = randomUUID();
    const nodeId = dto.nodeId.trim();
    const userId = dto.userId.trim();
    this.logger.log(
      `[Image Job] Nhận yêu cầu jobId=${jobId} nodeId=${nodeId}`,
    );
    void this.runImage(jobId, userId, nodeId, dto);
    return { jobId, nodeId, type: "image", status: "queued" };
  }

  private async runAiTask(
    jobId: string,
    userId: string,
    nodeId: string,
    dto: ExecuteAiTaskDto,
  ): Promise<void> {
    try {
      const result = await this.workflowAiService.executeAiTask(dto);
      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId,
        nodeId,
        type: "ai_task",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI Task job ${jobId} failed: ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId,
        nodeId,
        type: "ai_task",
        errorMessage,
        terminal: true,
      });
    }
  }

  private async runVoice(
    jobId: string,
    userId: string,
    nodeId: string,
    dto: ExecuteVoiceDto,
  ): Promise<void> {
    try {
      const result = await this.workflowVoiceService.executeVoice(dto);
      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId,
        nodeId,
        type: "voice",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Voice job ${jobId} failed: ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId,
        nodeId,
        type: "voice",
        errorMessage,
        terminal: true,
      });
    }
  }

  private async runImage(
    jobId: string,
    userId: string,
    nodeId: string,
    dto: ExecuteImageDto,
  ): Promise<void> {
    try {
      const result = await this.workflowImageService.executeImage(dto, (scene) => {
        this.realtimeGateway.notifyUser(userId, "workflow.image.scene.progress", {
          jobId,
          nodeId,
          sceneNumber: scene.sceneNumber,
          status: scene.status,
          imageUrl: scene.imageUrl,
          downloadUrl: scene.downloadUrl,
          errorMessage: scene.errorMessage,
          completedSoFar: scene.completedSoFar,
          totalScenes: scene.totalScenes,
        });
      });
      this.logger.log(
        `[Image Job] DONE jobId=${jobId} nodeId=${nodeId} — OK ${result.completedCount}/${result.images.length}, lỗi ${result.failedCount}`,
      );
      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId,
        nodeId,
        type: "image",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[Image Job] DONE FAILED jobId=${jobId} nodeId=${nodeId} — ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId,
        nodeId,
        type: "image",
        errorMessage,
        terminal: true,
      });
    }
  }

  submitRetryScene(dto: RetrySceneImageDto): WorkflowJobQueuedResponse {
    const jobId = randomUUID();
    const nodeId = dto.nodeId.trim();
    const userId = dto.userId.trim();
    this.logger.log(
      `[Image Retry] Nhận yêu cầu jobId=${jobId} nodeId=${nodeId} scene=${dto.sceneNumber}`,
    );
    void this.runRetryScene(jobId, userId, nodeId, dto);
    return { jobId, nodeId, type: "image", status: "queued" };
  }

  private async runRetryScene(
    jobId: string,
    userId: string,
    nodeId: string,
    dto: RetrySceneImageDto,
  ): Promise<void> {
    try {
      const result = await this.workflowImageService.retrySingleScene(dto);
      this.logger.log(
        `[Image Retry] DONE jobId=${jobId} ${result.status} scene=${dto.sceneNumber} nodeId=${nodeId}`,
      );
      this.realtimeGateway.notifyUser(userId, "workflow.image.scene.progress", {
        jobId,
        nodeId,
        sceneNumber: result.sceneNumber,
        status: result.status,
        imageUrl: result.imageUrl,
        downloadUrl: result.downloadUrl,
        errorMessage: result.errorMessage,
        completedSoFar: 1,
        totalScenes: 1,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[Image Retry] FAILED jobId=${jobId} nodeId=${nodeId} scene=${dto.sceneNumber} — ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "workflow.image.scene.progress", {
        jobId,
        nodeId,
        sceneNumber: dto.sceneNumber,
        status: "failed",
        imageUrl: null,
        downloadUrl: null,
        errorMessage,
        completedSoFar: 1,
        totalScenes: 1,
      });
    }
  }
}
