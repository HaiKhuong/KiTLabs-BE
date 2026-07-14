import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Put, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import { RetrySceneImageDto } from "./dto/retry-scene-image.dto";
import { UpsertWorkflowDto } from "./dto/upsert-workflow.dto";
import { WorkflowImageService } from "./workflow-image.service";
import { WorkflowJobsService } from "./workflow-jobs.service";
import { WorkflowService } from "./workflow.service";

@ApiTags("Workflow")
@ApiBearerAuth("bearer")
@Controller("tools/workflow")
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly workflowJobsService: WorkflowJobsService,
    private readonly workflowImageService: WorkflowImageService,
  ) {}

  @ApiOperation({ summary: "Get workflow by userId" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "name", required: false })
  @Public()
  @Get("workflows")
  async getWorkflow(@Query("userId") userId?: string, @Query("name") name?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.workflowService.getByUser(userId, name || "default");
  }

  @ApiOperation({ summary: "Create or update workflow" })
  @ApiBody({ type: UpsertWorkflowDto })
  @Public()
  @Put("workflows")
  async upsertWorkflow(@Body() dto: UpsertWorkflowDto) {
    return this.workflowService.upsert(dto);
  }

  @ApiOperation({ summary: "Queue AI Task — kết quả qua socket workflow.job.completed / failed" })
  @ApiBody({ type: ExecuteAiTaskDto })
  @Public()
  @Post("ai-task/execute")
  async executeAiTask(@Body() dto: ExecuteAiTaskDto) {
    return this.workflowJobsService.submitAiTask(dto);
  }

  @ApiOperation({ summary: "Queue Voice TTS — kết quả qua socket workflow.job.completed / failed" })
  @ApiBody({ type: ExecuteVoiceDto })
  @Public()
  @Post("voice/generate")
  async executeVoice(@Body() dto: ExecuteVoiceDto) {
    return this.workflowJobsService.submitVoice(dto);
  }

  @ApiOperation({ summary: "Queue Image gen — kết quả qua socket workflow.job.completed / failed" })
  @ApiBody({ type: ExecuteImageDto })
  @Public()
  @Post("image/generate")
  async executeImage(@Body() dto: ExecuteImageDto) {
    return this.workflowJobsService.submitImage(dto);
  }

  @ApiOperation({ summary: "Retry single scene image — kết quả qua socket workflow.image.scene.progress" })
  @ApiBody({ type: RetrySceneImageDto })
  @Public()
  @Post("image/retry-scene")
  async retrySceneImage(@Body() dto: RetrySceneImageDto) {
    return this.workflowJobsService.submitRetryScene(dto);
  }

  @ApiOperation({ summary: "Serve generated scene image (ComfyUI output PNG)" })
  @Public()
  @Get("images/:userId/:nodeId/:filename")
  async serveSceneImage(
    @Param("userId") userId: string,
    @Param("nodeId") nodeId: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    const abs = this.workflowImageService.resolveImageFilePath(userId, nodeId, filename);
    if (!abs) {
      throw new NotFoundException("Image not found");
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(abs);
  }
}
