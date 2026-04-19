import { BadRequestException, Controller, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { existsSync, mkdirSync } from "fs";
import { diskStorage } from "multer";
import { basename, extname, join } from "path";

import { Public } from "../../common/decorators/public.decorator";
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

const resolveLogoRelativeSubPath = (req: UploadRequest): string => {
  const userIdRaw = typeof req.query.userId === "string" ? req.query.userId : "";
  const userId = userIdRaw.replace(/[^a-zA-Z0-9-_]/g, "");
  return userId ? join(VIDEO_PIPELINE_LOGO_DIR, userId) : VIDEO_PIPELINE_LOGO_DIR;
};

const resolveLogoDestination = (req: UploadRequest): string => join(process.cwd(), resolveLogoRelativeSubPath(req));

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
  constructor(private readonly filesService: FilesService) {}

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
      path: pathUnderProjectRoot.replace("tools/video-pipeline/logo/", ""),
      /** Absolute path on the server filesystem. */
      filePath: file.path.replaceAll("\\", "/"),
      mimeType: file.mimetype,
      size: file.size,
    };
  }
}
