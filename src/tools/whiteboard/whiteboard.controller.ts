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
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import { extname } from "path";
import { memoryStorage } from "multer";

import { Public } from "../../common/decorators/public.decorator";
import { AnalyzeWhiteboardDto } from "./dto/analyze-whiteboard.dto";
import { GenerateWhiteboardIdeasDto } from "./dto/generate-whiteboard-ideas.dto";
import { MergeWhiteboardDto } from "./dto/merge-whiteboard.dto";
import { RenderWhiteboardDto } from "./dto/render-whiteboard.dto";
import { readImageDimensionsFromPath } from "./whiteboard-image";
import { WhiteboardIdeasService } from "./whiteboard-ideas.service";
import { WhiteboardSamplesService } from "./whiteboard-samples.service";
import { WhiteboardService } from "./whiteboard.service";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

const IMAGE_CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

@ApiTags("Whiteboard")
@ApiBearerAuth("bearer")
@Controller("tools/whiteboard")
export class WhiteboardController {
  constructor(
    private readonly whiteboardService: WhiteboardService,
    private readonly whiteboardIdeasService: WhiteboardIdeasService,
    private readonly whiteboardSamplesService: WhiteboardSamplesService,
  ) {}

  @ApiOperation({
    summary: "Generate whiteboard scene ideas (narration + imgDescription) via Gemini",
  })
  @ApiBody({ type: GenerateWhiteboardIdeasDto })
  @Public()
  @Post("ideas/generate")
  async generateIdeas(@Body() dto: GenerateWhiteboardIdeasDto) {
    return this.whiteboardIdeasService.generateAndSave(dto.userId, dto.idea);
  }

  @ApiOperation({ summary: "List whiteboard idea history for a user" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "search", required: false })
  @Public()
  @Get("ideas/history")
  async ideasHistory(
    @Query("userId") userId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
  ) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardIdeasService.listHistory(
      userId,
      Number(page) || 1,
      Number(limit) || 20,
      search,
    );
  }

  @ApiOperation({ summary: "Get one whiteboard idea history entry" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("ideas/history/:id")
  async getIdeaHistory(@Param("id") id: string, @Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardIdeasService.getOwnedById(id, userId);
  }

  @ApiOperation({ summary: "Delete all idea history for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("ideas/history")
  async deleteAllIdeaHistory(@Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardIdeasService.deleteAllHistory(userId);
  }

  @ApiOperation({ summary: "Delete a single idea history entry" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("ideas/history/:id")
  async deleteIdeaHistory(@Param("id") id: string, @Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardIdeasService.deleteHistory(id, userId);
  }

  @ApiOperation({
    summary: "Upload a composite image for manual box drawing — returns canvas size, no auto-detect",
  })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["userId", "image"],
      properties: {
        userId: { type: "string" },
        nodeId: { type: "string" },
        displayName: { type: "string" },
        image: { type: "string", format: "binary" },
      },
    },
  })
  @Public()
  @Post("analyze")
  @UseInterceptors(
    FileInterceptor("image", {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.WHITEBOARD_UPLOAD_MAX_BYTES ?? 30_000_000) },
      fileFilter: (_req, file, cb) => {
        if (!IMAGE_MIME.has(file.mimetype)) {
          cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async analyze(@Body() dto: AnalyzeWhiteboardDto, @UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException("image file is required");

    const draft = await this.whiteboardService.createAnalysisDraft(dto, file);
    const sourceImagePath = this.whiteboardService.resolveSourceImagePath(draft);
    const { imageWidth, imageHeight } = readImageDimensionsFromPath(sourceImagePath);
    await this.whiteboardService.savePreparedCanvas(draft.id, imageWidth, imageHeight);

    return {
      analysisId: draft.id,
      displayName: draft.displayName,
      imageWidth,
      imageHeight,
      objects: [],
      sourceImageUrl: `/api/tools/whiteboard/source-image?whiteboardHistoryId=${draft.id}`,
    };
  }

  @ApiOperation({
    summary: "Queue a render for a reviewed analysis — result via socket workflow.job.completed / failed",
  })
  @ApiBody({ type: RenderWhiteboardDto })
  @Public()
  @Post("render")
  async render(@Body() dto: RenderWhiteboardDto) {
    const queued = await this.whiteboardService.enqueueReviewed(dto);
    return {
      jobId: queued.id,
      nodeId: queued.nodeId,
      type: "whiteboard" as const,
      status: "queued" as const,
    };
  }

  @ApiOperation({
    summary: "Queue merge of completed scene videos with slide transitions (xfade)",
  })
  @ApiBody({ type: MergeWhiteboardDto })
  @Public()
  @Post("merge")
  async merge(@Body() dto: MergeWhiteboardDto) {
    const queued = await this.whiteboardService.enqueueMerge(dto);
    return {
      jobId: queued.id,
      nodeId: queued.nodeId,
      type: "whiteboard" as const,
      status: "queued" as const,
    };
  }

  @ApiOperation({ summary: "Read back a stored scene (bounding boxes + reading order)" })
  @ApiQuery({ name: "whiteboardHistoryId", required: true })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("scene")
  async scene(
    @Query("whiteboardHistoryId") whiteboardHistoryId: string,
    @Query("userId") userId: string,
  ) {
    if (!whiteboardHistoryId) throw new BadRequestException("whiteboardHistoryId is required");
    const history = await this.whiteboardService.getOwnedById(whiteboardHistoryId, userId);
    return this.whiteboardService.mapForClient(history);
  }

  @ApiOperation({ summary: "Stream the uploaded composite image used for review overlays" })
  @ApiQuery({ name: "whiteboardHistoryId", required: true })
  @Public()
  @Get("source-image")
  async sourceImage(
    @Query("whiteboardHistoryId") whiteboardHistoryId: string,
    @Res() res: Response,
  ) {
    if (!whiteboardHistoryId) throw new NotFoundException("whiteboardHistoryId is required");
    const history = await this.whiteboardService.getById(whiteboardHistoryId);
    if (!history) throw new NotFoundException("Whiteboard job not found");

    const filePath = this.whiteboardService.resolveSourceImagePath(history);
    const contentType = IMAGE_CONTENT_TYPE[extname(filePath).toLowerCase()] ?? "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(statSync(filePath).size));
    res.setHeader("Cache-Control", "private, max-age=3600");
    return createReadStream(filePath).pipe(res);
  }

  @ApiOperation({ summary: "List render history (paginated)" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({ name: "search", required: false })
  @Public()
  @Get("history")
  async history(
    @Query("userId") userId: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
  ) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardService.listHistory(userId, Number(page) || 1, Number(limit) || 20, search);
  }

  @ApiOperation({ summary: "Delete all history for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("history")
  async deleteAllHistory(@Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardService.deleteAllHistory(userId);
  }

  @ApiOperation({ summary: "Delete a single history entry" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("history/:id")
  async deleteHistory(@Param("id") id: string, @Query("userId") userId: string) {
    if (!userId) throw new BadRequestException("userId is required");
    return this.whiteboardService.deleteHistory(id, userId);
  }

  @ApiOperation({ summary: "List sample images for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("samples")
  async listSamples(@Query("userId") userId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    return this.whiteboardSamplesService.list(userId);
  }

  @ApiOperation({ summary: "Upload a sample image (stored in DB + disk)" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "userId", required: true })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("samples")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.WHITEBOARD_SAMPLE_MAX_BYTES ?? 12_000_000) },
    }),
  )
  async uploadSample(
    @UploadedFile() file: Express.Multer.File,
    @Query("userId") userId: string,
  ) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    if (!file) throw new BadRequestException("file is required");
    return this.whiteboardSamplesService.upload(userId, file);
  }

  @ApiOperation({ summary: "Stream a sample image" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("samples/:id")
  async getSample(
    @Param("id") id: string,
    @Query("userId") userId: string,
    @Res() res: Response,
  ) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const filePath = await this.whiteboardSamplesService.resolveOwnedPath(id, userId);
    const ext = extname(filePath).toLowerCase();
    const contentType =
      ext === ".svg" ? "image/svg+xml" : IMAGE_CONTENT_TYPE[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "private, max-age=3600");
    return createReadStream(filePath).pipe(res);
  }

  @ApiOperation({ summary: "Delete a sample image" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("samples/:id")
  async deleteSample(@Param("id") id: string, @Query("userId") userId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    return this.whiteboardSamplesService.delete(id, userId);
  }

  @ApiOperation({ summary: "Upload custom hand image for whiteboard render" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "userId", required: true })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("hand-image")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: Number(process.env.WHITEBOARD_HAND_MAX_BYTES ?? 8_000_000) },
    }),
  )
  async uploadHandImage(
    @UploadedFile() file: Express.Multer.File,
    @Query("userId") userId: string,
  ) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    if (!file) throw new BadRequestException("file is required");
    const saved = this.whiteboardService.saveHandImage(userId, file);
    return {
      userId,
      fileName: saved.fileName,
      previewUrl: `/api/tools/whiteboard/hand-image?userId=${encodeURIComponent(userId)}&t=${Date.now()}`,
    };
  }

  @ApiOperation({ summary: "Get the current custom hand image for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("hand-image")
  async getHandImage(@Query("userId") userId: string, @Res() res: Response) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const filePath = this.whiteboardService.resolveHandImagePath(userId);
    if (!filePath) throw new NotFoundException("Hand image not found");

    const ext = extname(filePath).toLowerCase();
    const contentType =
      ext === ".svg" ? "image/svg+xml" : IMAGE_CONTENT_TYPE[ext] ?? "application/octet-stream";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "no-cache");
    return createReadStream(filePath).pipe(res);
  }

  @ApiOperation({ summary: "Clear the custom hand image for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete("hand-image")
  async clearHandImage(@Query("userId") userId: string) {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    this.whiteboardService.clearHandImage(userId);
    return { ok: true };
  }

  @ApiOperation({ summary: "Stream rendered whiteboard MP4 (range requests supported)" })
  @ApiQuery({ name: "whiteboardHistoryId", required: true })
  @Public()
  @Get("artifact")
  async artifact(
    @Query("whiteboardHistoryId") whiteboardHistoryId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!whiteboardHistoryId) throw new NotFoundException("whiteboardHistoryId is required");
    const history = await this.whiteboardService.getById(whiteboardHistoryId);
    if (!history) throw new NotFoundException("Whiteboard job not found");

    const filePath = this.whiteboardService.resolveArtifactPath(history);
    if (!existsSync(filePath)) throw new NotFoundException("Artifact not found");

    const { size: fileSize } = statSync(filePath);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="${history.resultFileName ?? "whiteboard.mp4"}"`);
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type");

    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match) {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : fileSize - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end >= fileSize || start > end) {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.end();
      }
      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
      res.setHeader("Content-Length", String(chunkSize));
      return createReadStream(filePath, { start, end }).pipe(res);
    }

    res.setHeader("Content-Length", String(fileSize));
    return createReadStream(filePath).pipe(res);
  }
}
