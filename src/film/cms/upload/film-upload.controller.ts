import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { randomBytes } from "crypto";
import { existsSync, mkdirSync } from "fs";
import { diskStorage } from "multer";
import { extname, isAbsolute, join, resolve } from "path";
import { Response } from "express";

import { Public } from "../../../common/decorators/public.decorator";
import { FilmCmsAccess } from "../shared/film-cms.decorators";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  "image/avif",
]);

export function getFilmUploadDir(): string {
  const custom = process.env.FILM_UPLOAD_DIR?.trim();
  if (custom) {
    return isAbsolute(custom) ? custom : resolve(process.cwd(), custom);
  }
  const root = process.env.KITLABS_DATA_ROOT?.trim();
  if (root) {
    return resolve(root, "uploads", "film");
  }
  return resolve(process.cwd(), "uploads", "film");
}

function sanitizeType(type?: string): string {
  const lower = (type || "").trim().toLowerCase();
  if (["poster", "posters"].includes(lower)) return "posters";
  if (["banner", "banners"].includes(lower)) return "banners";
  return "general";
}

@ApiTags("Film CMS - Uploads")
@Controller("film")
export class FilmUploadController {
  @ApiOperation({ summary: "Upload image for film poster, banner or assets" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "type", required: false, enum: ["poster", "banner", "general"], description: "Image category" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
      },
      required: ["file"],
    },
  })
  @FilmCmsAccess()
  @Post("admin/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: {
        fileSize: Number(process.env.FILM_UPLOAD_MAX_BYTES ?? 15 * 1024 * 1024), // 15MB default
      },
      fileFilter: (_req, file, cb) => {
        if (!ALLOWED_IMAGE_MIME_TYPES.has(file.mimetype)) {
          return cb(
            new BadRequestException(
              `Định dạng file không được hỗ trợ (${file.mimetype}). Chỉ chấp nhận JPG, PNG, WEBP, GIF, SVG, AVIF.`,
            ),
            false,
          );
        }
        cb(null, true);
      },
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const type = sanitizeType(String(req.query?.type ?? "general"));
          const baseDir = getFilmUploadDir();
          const targetDir = join(baseDir, type);
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
          }
          cb(null, targetDir);
        },
        filename: (req, file, cb) => {
          const type = sanitizeType(String(req.query?.type ?? "general"));
          const ext = extname(file.originalname).toLowerCase() || ".png";
          const uniqueSuffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
          const prefix = type.endsWith("s") ? type.slice(0, -1) : type;
          cb(null, `${prefix}-${uniqueSuffix}${ext}`);
        },
      }),
    }),
  )
  uploadImage(
    @UploadedFile() file: Express.Multer.File,
    @Query("type") typeQuery?: string,
  ) {
    if (!file) {
      throw new BadRequestException("File ảnh không được để trống");
    }

    const type = sanitizeType(typeQuery);
    const relativeUrl = `/api/film/uploads/${type}/${file.filename}`;

    return {
      url: relativeUrl,
      fileName: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
      type,
    };
  }

  @ApiOperation({ summary: "Serve uploaded static film image" })
  @Public()
  @Get("uploads/:folder/:filename")
  serveFolderImage(
    @Param("folder") folder: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    return this.serveFile(folder, filename, res);
  }

  @ApiOperation({ summary: "Serve uploaded static film image directly" })
  @Public()
  @Get("uploads/:filename")
  serveDirectImage(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    return this.serveFile("general", filename, res);
  }

  private serveFile(folder: string, rawFilename: string, res: Response) {
    // Prevent directory traversal attacks
    const safeFolder = sanitizeType(folder);
    const safeFilename = rawFilename.replace(/[/\\?%*:|"<>]/g, "");

    const baseDir = getFilmUploadDir();
    const filePath = join(baseDir, safeFolder, safeFilename);

    if (!existsSync(filePath)) {
      // Fallback check in root upload dir
      const directFilePath = join(baseDir, safeFilename);
      if (existsSync(directFilePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        return res.sendFile(directFilePath);
      }
      throw new NotFoundException("Hình ảnh không tồn tại trên hệ thống");
    }

    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    return res.sendFile(filePath);
  }
}
