import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { GenerateVeoVideoDto } from "./dto/generate-veo-video.dto";
import { GeminiVeoService } from "./gemini-veo.service";
import { VideoHistoryService } from "./video-history.service";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos/veo")
export class VideosController {
  constructor(
    private readonly geminiVeoService: GeminiVeoService,
    private readonly videoHistoryService: VideoHistoryService,
  ) {}

  @ApiOperation({ summary: "Gemini Veo parameter capabilities and constraints for UI" })
  @Public()
  @Get("capabilities")
  getCapabilities() {
    return this.geminiVeoService.getCapabilities();
  }

  @ApiOperation({
    summary: "Start a Gemini Veo text/image/reference-image video generation operation",
  })
  @Public()
  @Post("generate")
  generate(@Body() dto: GenerateVeoVideoDto) {
    return this.geminiVeoService.generate(dto);
  }

  @ApiOperation({ summary: "List a user's Gemini Veo generation history" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get("jobs")
  async listJobs(@Query("userId") userId?: string, @Query("page") page?: string, @Query("limit") limit?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    const result = await this.videoHistoryService.getHistory(userId, {
      page: page ? Number(page) : 1,
      limit: limit ? Number(limit) : 20,
    });
    return {
      ...result,
      items: result.items.map((item) => this.videoHistoryService.mapForClient(item)),
    };
  }

  @ApiOperation({ summary: "Delete all Gemini Veo history for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("jobs")
  async deleteAllJobs(@Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.videoHistoryService.deleteAllHistory(userId);
  }

  @ApiOperation({ summary: "Delete one Gemini Veo history item" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("jobs/:id")
  async deleteJob(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    await this.videoHistoryService.deleteHistory(userId, id);
    return { deleted: true, id };
  }

  @ApiOperation({ summary: "Get a Gemini Veo long-running operation status" })
  @ApiQuery({ name: "operationName", required: true })
  @ApiQuery({ name: "apiKeyTier", enum: ["normal", "vip"], required: false })
  @Public()
  @Get("operations/status")
  getOperation(@Query("operationName") operationName: string, @Query("apiKeyTier") apiKeyTier?: string) {
    return this.geminiVeoService.getOperation(operationName, apiKeyTier);
  }

  @ApiOperation({ summary: "Proxy-download a completed Gemini Veo MP4 result" })
  @ApiProduces("video/mp4")
  @ApiQuery({ name: "operationName", required: true })
  @ApiQuery({ name: "apiKeyTier", enum: ["normal", "vip"], required: false })
  @Public()
  @Get("operations/video")
  async downloadVideo(
    @Query("operationName") operationName: string,
    @Query("apiKeyTier") apiKeyTier: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.geminiVeoService.downloadGeneratedVideo(operationName, apiKeyTier);
    response.setHeader("Content-Type", result.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    if (result.contentLength) {
      response.setHeader("Content-Length", result.contentLength);
    }
    return result.stream.pipe(response);
  }
}
