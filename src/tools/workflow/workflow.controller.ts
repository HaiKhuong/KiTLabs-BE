import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { CreateWorkflowDto } from "./dto/create-workflow.dto";
import { CreateWorkflowRunDto } from "./dto/create-workflow-run.dto";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import { RenameWorkflowDto } from "./dto/rename-workflow.dto";
import { RetrySceneImageDto } from "./dto/retry-scene-image.dto";
import { UpsertWorkflowDto } from "./dto/upsert-workflow.dto";
import { WorkflowImageService } from "./workflow-image.service";
import { WorkflowJobsService } from "./workflow-jobs.service";
import { WorkflowRunService } from "./workflow-run.service";
import { WorkflowService } from "./workflow.service";

@ApiTags("Workflow")
@ApiBearerAuth("bearer")
@Controller("tools/workflow")
export class WorkflowController {
  constructor(
    private readonly workflowService: WorkflowService,
    private readonly workflowRunService: WorkflowRunService,
    private readonly workflowJobsService: WorkflowJobsService,
    private readonly workflowImageService: WorkflowImageService,
  ) {}

  @ApiOperation({ summary: "List workflow profiles for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("workflows/list")
  async listWorkflows(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.workflowService.listByUser(userId);
  }

  @ApiOperation({
    summary: "List workflow profiles (no name) or get one document (with name)",
  })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "name", required: false })
  @Public()
  @Get("workflows")
  async getWorkflows(@Query("userId") userId?: string, @Query("name") name?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    if (!name?.trim()) {
      return this.workflowService.listByUser(userId);
    }
    return this.workflowService.getByUser(userId, name);
  }

  @ApiOperation({ summary: "Create a new workflow profile" })
  @ApiBody({ type: CreateWorkflowDto })
  @Public()
  @Post("workflows")
  async createWorkflow(@Body() dto: CreateWorkflowDto) {
    return this.workflowService.create(dto);
  }

  @ApiOperation({ summary: "Create or update workflow document" })
  @ApiBody({ type: UpsertWorkflowDto })
  @Public()
  @Put("workflows")
  async upsertWorkflow(@Body() dto: UpsertWorkflowDto) {
    return this.workflowService.upsert(dto);
  }

  @ApiOperation({ summary: "Rename a workflow profile" })
  @ApiBody({ type: RenameWorkflowDto })
  @Public()
  @Patch("workflows/:id")
  async renameWorkflow(@Param("id") id: string, @Body() dto: RenameWorkflowDto) {
    return this.workflowService.rename(id, dto);
  }

  @ApiOperation({ summary: "Delete a workflow profile (cascades run history)" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("workflows/:id")
  async deleteWorkflow(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.workflowService.remove(id, userId);
  }

  @ApiOperation({ summary: "Save a workflow run snapshot" })
  @ApiBody({ type: CreateWorkflowRunDto })
  @Public()
  @Post("runs")
  async createRun(@Body() dto: CreateWorkflowRunDto) {
    return this.workflowRunService.create(dto);
  }

  @ApiOperation({ summary: "List run history for a workflow profile" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "workflowId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get("runs")
  async listRuns(
    @Query("userId") userId?: string,
    @Query("workflowId") workflowId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    if (!userId) throw new BadRequestException("userId is required");
    if (!workflowId) throw new BadRequestException("workflowId is required");
    return this.workflowRunService.list(userId, workflowId, Number(page) || 1, Number(limit) || 20);
  }

  @ApiOperation({ summary: "Get one run (full snapshot)" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("runs/:id")
  async getRun(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.workflowRunService.getById(id, userId);
  }

  @ApiOperation({ summary: "Delete one run" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("runs/:id")
  async deleteRun(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.workflowRunService.deleteOne(id, userId);
  }

  @ApiOperation({ summary: "Clear all runs for a workflow profile" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "workflowId", required: true })
  @Public()
  @Delete("runs")
  async clearRuns(@Query("userId") userId?: string, @Query("workflowId") workflowId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    if (!workflowId) throw new BadRequestException("workflowId is required");
    return this.workflowRunService.deleteAll(userId, workflowId);
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
