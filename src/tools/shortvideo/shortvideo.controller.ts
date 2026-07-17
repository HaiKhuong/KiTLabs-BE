import {
  Controller,
  Get,
  NotFoundException,
  Post,
  Body,
  Query,
  Req,
  Res,
  UploadedFiles,
  UseInterceptors,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import { memoryStorage } from "multer";

import { Public } from "../../common/decorators/public.decorator";
import { CreateShortVideoJobDto } from "./dto/create-shortvideo-job.dto";
import { RenderShortVideoUploadDto } from "./dto/render-shortvideo-upload.dto";
import { ShortVideoService } from "./shortvideo.service";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const AUDIO_MIME = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
]);

@ApiTags("ShortVideo")
@ApiBearerAuth("bearer")
@Controller("tools/shortvideo")
export class ShortVideoController {
  constructor(private readonly shortVideoService: ShortVideoService) {}

  @ApiOperation({
    summary: "Queue a 9:16 ShortVideo render — result via socket workflow.job.completed / failed",
  })
  @ApiBody({ type: CreateShortVideoJobDto })
  @Public()
  @Post("render")
  async render(@Body() dto: CreateShortVideoJobDto) {
    const created = await this.shortVideoService.enqueue(dto);
    return {
      jobId: created.id,
      nodeId: created.nodeId,
      type: "short_video" as const,
      status: "queued" as const,
    };
  }

  @ApiOperation({
    summary:
      "Upload assets (background/left/right/voice) + JSON spec and queue a 9:16 render — result via socket",
  })
  @ApiConsumes("multipart/form-data")
  @Public()
  @Post("render-upload")
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: "background", maxCount: 1 },
        { name: "left", maxCount: 1 },
        { name: "right", maxCount: 1 },
        { name: "voice", maxCount: 1 },
      ],
      {
        storage: memoryStorage(),
        limits: { fileSize: Number(process.env.SHORTVIDEO_UPLOAD_MAX_BYTES ?? 50_000_000) },
        fileFilter: (_req, file, cb) => {
          const allowed = file.fieldname === "voice" ? AUDIO_MIME : IMAGE_MIME;
          if (!allowed.has(file.mimetype)) {
            cb(new Error(`Unsupported file type for ${file.fieldname}: ${file.mimetype}`), false);
            return;
          }
          cb(null, true);
        },
      },
    ),
  )
  async renderUpload(
    @Body() dto: RenderShortVideoUploadDto,
    @UploadedFiles()
    files: {
      background?: Express.Multer.File[];
      left?: Express.Multer.File[];
      right?: Express.Multer.File[];
      voice?: Express.Multer.File[];
    },
  ) {
    const created = await this.shortVideoService.enqueueFromUpload(dto, files ?? {});
    return {
      jobId: created.id,
      nodeId: created.nodeId,
      type: "short_video" as const,
      status: "queued" as const,
    };
  }

  @ApiOperation({ summary: "Stream a rendered ShortVideo mp4 (range requests supported)" })
  @ApiQuery({ name: "shortVideoHistoryId", required: true })
  @Public()
  @Get("artifact")
  async artifact(
    @Query("shortVideoHistoryId") shortVideoHistoryId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!shortVideoHistoryId) throw new NotFoundException("shortVideoHistoryId is required");
    const history = await this.shortVideoService.getById(shortVideoHistoryId);
    if (!history) throw new NotFoundException("ShortVideo job not found");

    const filePath = this.shortVideoService.resolveArtifactPath(history);
    if (!existsSync(filePath)) throw new NotFoundException("Artifact not found");

    const { size: fileSize } = statSync(filePath);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="${history.resultFileName ?? "short_video.mp4"}"`,
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Accept-Ranges, Content-Range, Content-Length, Content-Type",
    );

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
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end >= fileSize ||
        start > end
      ) {
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
