import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { GenerateStudioImageDto } from "./dto/generate-studio-image.dto";
import { ImagesHistoryService } from "./images-history.service";
import { ImagesJobsService } from "./images-jobs.service";
import { WorkflowImageService } from "../workflow/workflow-image.service";

@ApiTags("Images")
@ApiBearerAuth("bearer")
@Controller("tools/images")
export class ImagesController {
  constructor(
    private readonly imagesJobsService: ImagesJobsService,
    private readonly imagesHistoryService: ImagesHistoryService,
    private readonly workflowImageService: WorkflowImageService,
  ) {}

  @ApiOperation({
    summary: "Queue studio image generation — kết quả qua socket images.studio.completed / failed",
  })
  @ApiBody({ type: GenerateStudioImageDto })
  @Public()
  @Post("generate")
  async generate(@Body() dto: GenerateStudioImageDto) {
    return this.imagesJobsService.submitStudioImage(dto);
  }

  @ApiOperation({ summary: "List user image generation jobs (paginated)" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get("jobs")
  async listJobs(
    @Query("userId") userId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    const result = await this.imagesHistoryService.getHistory(userId, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    return {
      items: result.items.map((row) => this.imagesHistoryService.mapHistoryForClient(row)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
    };
  }

  @ApiOperation({ summary: "Delete all image generation jobs for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("jobs")
  async deleteAllJobs(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.imagesHistoryService.deleteAllHistory(userId);
  }

  @ApiOperation({ summary: "Get image job by id" })
  @Public()
  @Get("jobs/:id")
  async getJob(@Param("id") id: string) {
    const row = await this.imagesHistoryService.getById(id);
    if (!row) {
      throw new BadRequestException("Job not found");
    }
    return this.imagesHistoryService.mapHistoryForClient(row);
  }

  @ApiOperation({ summary: "Delete an image generation job" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("jobs/:id")
  async deleteJob(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    await this.imagesHistoryService.deleteHistory(userId, id);
    return { deleted: true, id };
  }

  @ApiOperation({ summary: "Serve generated studio image PNG" })
  @Public()
  @Get(":userId/:jobId/:filename")
  async serveImage(
    @Param("userId") userId: string,
    @Param("jobId") jobId: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    const abs = this.workflowImageService.resolveImageFilePath(userId, jobId, filename);
    if (!abs) {
      throw new NotFoundException("Image not found");
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(abs);
  }
}
