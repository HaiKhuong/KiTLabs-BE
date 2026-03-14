import { BadRequestException, Controller, Post, Query, UploadedFile, UseInterceptors } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import { existsSync, mkdirSync } from "fs";
import { diskStorage } from "multer";
import { extname, join } from "path";

import { FilesService } from "./files.service";

@ApiTags("Files")
@ApiBearerAuth("bearer")
@Controller("tools/files")
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  @ApiOperation({ summary: "Upload file to local storage" })
  @ApiConsumes("multipart/form-data")
  @ApiQuery({ name: "folder", required: false, description: "Upload folder name" })
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "binary",
        },
      },
      required: ["file"],
    },
  })
  @Post("upload")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: diskStorage({
        destination: (req, _file, cb) => {
          const folderQuery = String(req.query.folder ?? "videos");
          const folder = folderQuery.length > 0 ? folderQuery : "videos";
          const destination =
            process.env.UPLOAD_DIR && process.env.UPLOAD_DIR.length > 0
              ? join(process.env.UPLOAD_DIR, folder)
              : join("uploads", folder);
          if (!existsSync(destination)) {
            mkdirSync(destination, { recursive: true });
          }
          cb(null, destination);
        },
        filename: (_req, file, cb) => {
          const unique = `${Date.now()}_${Math.round(Math.random() * 1e9)}`;
          cb(null, `${unique}${extname(file.originalname)}`);
        },
      }),
      limits: { fileSize: Number(process.env.UPLOAD_MAX_BYTES ?? 500000000) },
    }),
  )
  upload(@UploadedFile() file: Express.Multer.File, @Query("folder") folder?: string) {
    this.filesService.ensureUploadFolder(folder ?? "videos");
    if (!file) {
      throw new BadRequestException("file is required");
    }

    return {
      originalName: file.originalname,
      fileName: file.filename,
      filePath: file.path.replaceAll("\\", "/"),
      mimeType: file.mimetype,
      size: file.size,
    };
  }
}
