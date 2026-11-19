import { BadRequestException, Body, Controller, Delete, Get, Logger, NotFoundException, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { existsSync } from "fs";
import { mkdir, rm, writeFile } from "fs/promises";
import { join, resolve } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { GFlowRunnerService } from "../gflow/gflow-runner.service";
import { GenerateVeoVideoDto } from "./dto/generate-veo-video.dto";
import { GeminiVeoService } from "./gemini-veo.service";
import { VideoHistoryService } from "./video-history.service";

const GFLOW_VIDEO_FILENAME = "output.mp4";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos/veo")
export class VideosController {
  private readonly logger = new Logger(VideosController.name);

  constructor(
    private readonly geminiVeoService: GeminiVeoService,
    private readonly videoHistoryService: VideoHistoryService,
    private readonly gflowRunner: GFlowRunnerService,
  ) {}

  @ApiOperation({ summary: "Gemini Veo parameter capabilities and constraints for UI" })
  @Public()
  @Get("capabilities")
  getCapabilities() {
    return this.geminiVeoService.getCapabilities();
  }

  @ApiOperation({
    summary: "Start a Gemini Veo or Google Flow text/image/reference-image video generation operation",
  })
  @Public()
  @Post("generate")
  async generate(@Body() dto: GenerateVeoVideoDto) {
    if (dto.provider === "gflow") {
      const model = dto.model ?? "omni-flash";
      const history = await this.videoHistoryService.createPending(dto, model);
      void this.runGFlowVideo(history.id, dto);
      return {
        historyId: history.id,
        operationName: null,
        done: false,
        model,
        apiKeyTier: dto.apiKeyTier ?? "normal",
        provider: "gflow",
      };
    }
    return this.geminiVeoService.generate(dto);
  }

  private async runGFlowVideo(historyId: string, dto: GenerateVeoVideoDto): Promise<void> {
    const outDir = resolve(process.cwd(), "uploads", "tools", "videos", dto.userId.trim(), historyId);
    const outPath = join(outDir, GFLOW_VIDEO_FILENAME);
    const tempRefPaths: string[] = [];
    try {
      await this.videoHistoryService.markRunningLocal(historyId);
      await mkdir(outDir, { recursive: true });
      const refs = dto.referenceImages?.length
        ? dto.referenceImages
        : dto.firstFrame
          ? [dto.firstFrame]
          : [];
      for (let idx = 0; idx < refs.length; idx++) {
        const refImage = refs[idx];
        if (!refImage?.data) continue;
        const ext = refImage.mimeType === "image/png" ? ".png" : refImage.mimeType === "image/webp" ? ".webp" : ".jpg";
        const refPath = join(outDir, `_ref_${historyId}_${idx}${ext}`);
        await writeFile(refPath, Buffer.from(refImage.data, "base64"));
        tempRefPaths.push(refPath);
      }
      const res = await this.gflowRunner.generateVideo({
        prompt: dto.prompt.trim(),
        outputFile: outPath,
        referenceImages: tempRefPaths,
        aspect: dto.aspectRatio ?? "16:9",
        model: dto.model ?? "omni-flash",
        resolution: dto.resolution === "360p" ? "360p" : "720p",
        duration: dto.durationSeconds ?? 8,
        voice: dto.voice,
      });
      await this.videoHistoryService.markCompletedLocal(historyId, {
        resultPath: res.outputPath,
        resultFileName: GFLOW_VIDEO_FILENAME,
        gflowProfile: res.profile ?? null,
      });
    } catch (error) {
      this.logger.warn(`[GFlow Video] Failed historyId=${historyId}: ${error instanceof Error ? error.message : String(error)}`);
      await this.videoHistoryService.markFailed(historyId, error);
    } finally {
      for (const p of tempRefPaths) {
        await rm(p, { force: true }).catch(() => undefined);
      }
    }
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

  @ApiOperation({ summary: "Serve locally generated GFlow MP4 video" })
  @ApiProduces("video/mp4")
  @Public()
  @Get("files/:userId/:historyId/:filename")
  async serveLocalVideo(
    @Param("userId") userId: string,
    @Param("historyId") historyId: string,
    @Param("filename") filename: string,
    @Res() response: Response,
  ) {
    const row = await this.videoHistoryService.getById(historyId);
    if (!row || row.userId !== userId || !row.resultPath || row.resultFileName !== filename) {
      throw new NotFoundException("Video file not found");
    }
    const absPath = resolve(row.resultPath);
    if (!existsSync(absPath)) {
      throw new NotFoundException("Video file missing on disk");
    }
    return response.sendFile(absPath);
  }
}
