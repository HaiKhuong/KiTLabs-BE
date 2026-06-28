import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiHeader, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request } from "express";
import { existsSync, mkdirSync } from "fs";
import { diskStorage } from "multer";
import { basename, extname, join } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { ChunkUploadService } from "./chunk-upload.service";
import { CancelUploadDto, CompleteUploadDto, InitUploadDto } from "./dto/chunk-upload.dto";
import { FilesService } from "./files.service";

type UploadRequest = {
  query: Record<string, unknown>;
  uploadDestination?: string;
};

const LOGO_ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const resolveUploadDestination = (req: UploadRequest): string => {
  const folderQuery = String(req.query.folder ?? "videos");
  const folder = folderQuery.length > 0 ? folderQuery : "videos";
  const userIdRaw = typeof req.query.userId === "string" ? req.query.userId : "";
  const userId = userIdRaw.replace(/[^a-zA-Z0-9-_]/g, "");
  const targetFolder = userId ? join(folder, userId) : folder;

  return process.env.UPLOAD_DIR && process.env.UPLOAD_DIR.length > 0
    ? join(process.env.UPLOAD_DIR, targetFolder)
    : join("uploads", targetFolder);
};

/** Project-relative base for video pipeline logos (see tools/video-pipeline/). */
const VIDEO_PIPELINE_LOGO_DIR = join("tools", "video-pipeline", "logo");
const VIDEO_PIPELINE_OUTRO_DIR = join("tools", "video-pipeline", "outro");

const OUTRO_ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/x-matroska",
  "video/x-msvideo",
]);

const resolveLogoRelativeSubPath = (req: UploadRequest): string => {
  const userIdRaw = typeof req.query.userId === "string" ? req.query.userId : "";
  const userId = userIdRaw.replace(/[^a-zA-Z0-9-_]/g, "");
  return userId ? join(VIDEO_PIPELINE_LOGO_DIR, userId) : VIDEO_PIPELINE_LOGO_DIR;
};

const resolveLogoDestination = (req: UploadRequest): string => join(process.cwd(), resolveLogoRelativeSubPath(req));

const resolveOutroRelativeSubPath = (req: UploadRequest): string => {
  const userIdRaw = typeof req.query.userId === "string" ? req.query.userId : "";
  const userId = userIdRaw.replace(/[^a-zA-Z0-9-_]/g, "");
  return userId ? join(VIDEO_PIPELINE_OUTRO_DIR, userId) : VIDEO_PIPELINE_OUTRO_DIR;
};

const resolveOutroDestination = (req: UploadRequest): string => join(process.cwd(), resolveOutroRelativeSubPath(req));

const sanitizeFileBaseName = (name: string): string =>
  name
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();

const hasValidUserId = (req: UploadRequest): boolean =>
  typeof req.query.userId === "string" && req.query.userId.replace(/[^a-zA-Z0-9-_]/g, "").length > 0;

const buildStoredFileName = (destination: string, originalName: string, allowOverwriteExisting: boolean): string => {
  const fileExt = extname(originalName);
  const rawBaseName = basename(originalName, fileExt);
  const safeBaseName = sanitizeFileBaseName(rawBaseName) || `upload_${Date.now()}`;
  let fileName = `${safeBaseName}${fileExt}`;

  if (!allowOverwriteExisting && existsSync(join(destination, fileName))) {
    fileName = `${safeBaseName}_${Date.now()}${fileExt}`;
  }

  return fileName;
};

@ApiTags("Files")
@ApiBearerAuth("bearer")
@Controller("tools/files")
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly chunkUploadService: ChunkUploadService,
  ) {}

  @ApiOperation({ summary: "Upload file to local storage" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "folder", required: false, description: "Upload folder name" })
  @ApiQuery({ name: "userId", required: false, description: "Owner user id for grouping uploads" })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = resolveUploadDestination(uploadRequest);

          if (!existsSync(destination)) {
            mkdirSync(destination, { recursive: true });
          }
          uploadRequest.uploadDestination = destination;
          cb(null, destination);
        },
        filename: (req, file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = uploadRequest.uploadDestination ?? resolveUploadDestination(uploadRequest);
          cb(null, buildStoredFileName(destination, file.originalname, hasValidUserId(uploadRequest)));
        },
      }),
      limits: { fileSize: Number(process.env.UPLOAD_MAX_BYTES ?? 500000000) },
    }),
  )
  upload(
    @UploadedFile() file: Express.Multer.File,
    @Query("folder") folder?: string,
    @Query("userId") userId?: string,
  ) {
    this.filesService.ensureUploadFolder(userId ? `${folder ?? "videos"}_${userId}` : (folder ?? "videos"));
    if (!file) {
      throw new BadRequestException("file is required");
    }

    return {
      userId: userId ?? null,
      originalName: file.originalname,
      fileName: file.filename,
      filePath: file.path.replaceAll("\\", "/"),
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  @ApiOperation({ summary: "Upload logo image to tools/video-pipeline/logo" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({
    name: "userId",
    required: false,
    description: "Optional owner id; files go under tools/video-pipeline/logo/<userId>/",
  })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("upload-logo")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = resolveLogoDestination(uploadRequest);
          if (!existsSync(destination)) {
            mkdirSync(destination, { recursive: true });
          }
          uploadRequest.uploadDestination = destination;
          cb(null, destination);
        },
        filename: (req, file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = uploadRequest.uploadDestination ?? resolveLogoDestination(uploadRequest);
          cb(null, buildStoredFileName(destination, file.originalname, hasValidUserId(uploadRequest)));
        },
      }),
      limits: { fileSize: Number(process.env.LOGO_UPLOAD_MAX_BYTES ?? 15_000_000) },
      fileFilter: (_req, file, cb) => {
        if (!LOGO_ALLOWED_MIME_TYPES.has(file.mimetype)) {
          cb(new BadRequestException("Logo must be an image (PNG, JPEG, GIF, WebP, or SVG)."), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadLogo(@UploadedFile() file: Express.Multer.File, @Query("userId") userId?: string) {
    if (!file) {
      throw new BadRequestException("file is required");
    }

    const reqStub = { query: { userId } } as UploadRequest;
    const subPath = resolveLogoRelativeSubPath(reqStub);
    const pathUnderProjectRoot = join(subPath, file.filename).replaceAll("\\", "/");

    return {
      userId: userId ?? null,
      originalName: file.originalname,
      fileName: file.filename,
      /** Path relative to project root (e.g. tools/video-pipeline/logo/acme.png). */
      path: pathUnderProjectRoot.replace("/home/haikhuong/sources/KiTLabs-BE/tools/video-pipeline/logo/", "logo/"),
      /** Absolute path on the server filesystem. */
      filePath: file.path
        .replaceAll("\\", "/")
        .replace("/home/haikhuong/sources/KiTLabs-BE/tools/video-pipeline/logo/", "logo/"),
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  @ApiOperation({ summary: "Upload outro video clip to tools/video-pipeline/outro" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({
    name: "userId",
    required: false,
    description: "Optional owner id; files go under tools/video-pipeline/outro/<userId>/",
  })
  @ApiBody({
    schema: { type: "object", properties: { file: { type: "string", format: "binary" } }, required: ["file"] },
  })
  @Public()
  @Post("upload-outro")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = resolveOutroDestination(uploadRequest);
          if (!existsSync(destination)) {
            mkdirSync(destination, { recursive: true });
          }
          uploadRequest.uploadDestination = destination;
          cb(null, destination);
        },
        filename: (req, file, cb) => {
          const uploadRequest = req as UploadRequest;
          const destination = uploadRequest.uploadDestination ?? resolveOutroDestination(uploadRequest);
          cb(null, buildStoredFileName(destination, file.originalname, hasValidUserId(uploadRequest)));
        },
      }),
      limits: { fileSize: Number(process.env.OUTRO_UPLOAD_MAX_BYTES ?? 200_000_000) },
      fileFilter: (_req, file, cb) => {
        if (!OUTRO_ALLOWED_MIME_TYPES.has(file.mimetype)) {
          cb(new BadRequestException("Outro must be a video (MP4, WebM, MOV, MKV, or AVI)."), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  uploadOutro(@UploadedFile() file: Express.Multer.File, @Query("userId") userId?: string) {
    if (!file) {
      throw new BadRequestException("file is required");
    }

    const reqStub = { query: { userId } } as UploadRequest;
    const subPath = resolveOutroRelativeSubPath(reqStub);
    const pathUnderProjectRoot = join(subPath, file.filename).replaceAll("\\", "/");

    return {
      userId: userId ?? null,
      originalName: file.originalname,
      fileName: file.filename,
      path: pathUnderProjectRoot,
      filePath: file.path.replaceAll("\\", "/"),
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  // ─── Chunk Upload Endpoints ────────────────────────────────────────

  @ApiOperation({ summary: "Initialize a chunked upload session" })
  @ApiBody({ type: InitUploadDto })
  @SkipThrottle()
  @Public()
  @Post("upload/init")
  initUpload(@Body() dto: InitUploadDto) {
    return this.chunkUploadService.initUpload(dto);
  }

  @ApiOperation({ summary: "Upload a single chunk" })
  @ApiConsumes("application/octet-stream")
  @ApiHeader({ name: "upload-id", required: true, description: "Upload session ID" })
  @ApiHeader({ name: "chunk-index", required: true, description: "Zero-based chunk index" })
  @ApiHeader({ name: "total-chunks", required: true, description: "Total number of chunks" })
  @ApiHeader({ name: "chunk-hash", required: false, description: "SHA-256 hash of the chunk for validation" })
  @SkipThrottle()
  @Public()
  @Post("upload/chunk")
  uploadChunk(
    @Headers("upload-id") uploadId: string,
    @Headers("chunk-index") chunkIndex: string,
    @Headers("total-chunks") totalChunks: string,
    @Headers("chunk-hash") chunkHash: string | undefined,
    @Req() req: Request,
  ) {
    if (!uploadId || !chunkIndex || !totalChunks) {
      throw new BadRequestException("upload-id, chunk-index, and total-chunks headers are required");
    }
    return this.chunkUploadService.uploadChunk(
      uploadId,
      parseInt(chunkIndex, 10),
      parseInt(totalChunks, 10),
      chunkHash,
      req,
    );
  }

  @ApiOperation({ summary: "Get upload status for resume" })
  @ApiQuery({ name: "uploadId", required: true, description: "Upload session ID" })
  @SkipThrottle()
  @Public()
  @Get("upload/status")
  getUploadStatus(@Query("uploadId") uploadId: string) {
    if (!uploadId) {
      throw new BadRequestException("uploadId query parameter is required");
    }
    return this.chunkUploadService.getStatus(uploadId);
  }

  @ApiOperation({ summary: "Complete upload — merge all chunks into final file" })
  @ApiBody({ type: CompleteUploadDto })
  @SkipThrottle()
  @Public()
  @Post("upload/complete")
  completeUpload(@Body() dto: CompleteUploadDto) {
    return this.chunkUploadService.completeUpload(dto.uploadId);
  }

  @ApiOperation({ summary: "Cancel an in-progress upload and clean up chunks" })
  @ApiQuery({ name: "uploadId", required: true, description: "Upload session ID" })
  @SkipThrottle()
  @Public()
  @Delete("upload/cancel")
  cancelUpload(@Query("uploadId") uploadId: string) {
    if (!uploadId) {
      throw new BadRequestException("uploadId query parameter is required");
    }
    return this.chunkUploadService.cancelUpload(uploadId);
  }
}
