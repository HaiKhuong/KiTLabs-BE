import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import type { WorkflowJobQueuedResponse } from "./dto/workflow-job-response.dto";
import { VideosAiService } from "./videos-ai.service";
import { VideosImageService } from "./videos-image.service";
import { VideosVoiceService } from "./videos-voice.service";

export type WorkflowJobType = "ai_task" | "voice" | "image";

@Injectable()
export class VideosJobsService {
  private readonly logger = new Logger(VideosJobsService.name);

  constructor(
    private readonly videosAiService: VideosAiService,
    private readonly videosVoiceService: VideosVoiceService,
    private readonly videosImageService: VideosImageService,
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
      const result = await this.videosAiService.executeAiTask(dto);
      this.realtimeGateway.notifyUser(userId, "videos.job.completed", {
        jobId,
        nodeId,
        type: "ai_task",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`AI Task job ${jobId} failed: ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "videos.job.failed", {
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
      const result = await this.videosVoiceService.executeVoice(dto);
      this.realtimeGateway.notifyUser(userId, "videos.job.completed", {
        jobId,
        nodeId,
        type: "voice",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Voice job ${jobId} failed: ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "videos.job.failed", {
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
      const result = await this.videosImageService.executeImage(dto);
      this.realtimeGateway.notifyUser(userId, "videos.job.completed", {
        jobId,
        nodeId,
        type: "image",
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Image job ${jobId} failed: ${errorMessage}`);
      this.realtimeGateway.notifyUser(userId, "videos.job.failed", {
        jobId,
        nodeId,
        type: "image",
        errorMessage,
        terminal: true,
      });
    }
  }
}
