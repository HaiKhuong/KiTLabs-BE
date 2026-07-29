import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Body,
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
import { memoryStorage } from "multer";

import { Public } from "../../common/decorators/public.decorator";
import { RenderWhiteboardUploadDto } from "./dto/render-whiteboard-upload.dto";
import { WhiteboardService } from "./whiteboard.service";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

@ApiTags("Whiteboard")
@ApiBearerAuth("bearer")
@Controller("tools/whiteboard")
export class WhiteboardController {
  constructor(private readonly whiteboardService: WhiteboardService) {}

  @ApiOperation({ summary: "Upload composite image + options and queue a whiteboard render" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      required: ["userId", "image"],
      properties: {
        userId: { type: "string" },
        nodeId: { type: "string" },
        displayName: { type: "string" },
        engineConfig: { type: "string", description: "JSON string with fps, durationSec, brushSize, brushSpeedPx" },
        image: { type: "string", format: "binary" },
      },
    },
  })
  @Public()
  @Post("render")
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
  async render(
    @Body() dto: RenderWhiteboardUploadDto,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException("image file is required");
    const created = await this.whiteboardService.enqueueFromUpload(dto, file);
    return {
      jobId: created.id,
      nodeId: created.nodeId,
      type: "whiteboard" as const,
      status: "queued" as const,
    };
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
