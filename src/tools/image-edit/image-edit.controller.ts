import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { memoryStorage } from "multer";

import { Public } from "../../common/decorators/public.decorator";
import { IMAGE_EDIT_FEATURES, IMAGE_EDIT_MAX_UPLOAD_BYTES } from "./image-edit.constants";
import { ImageEditHistoryService } from "./image-edit-history.service";
import { ImageEditService } from "./image-edit.service";

const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags("Image edit")
@ApiBearerAuth("bearer")
@Controller("tools/image-edit")
export class ImageEditController {
  constructor(
    private readonly imageEditService: ImageEditService,
    private readonly historyService: ImageEditHistoryService,
  ) {}

  @ApiOperation({ summary: "Queue an image edit job — result via socket image-edit.completed / failed" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        userId: { type: "string" },
        feature: { type: "string", enum: [...IMAGE_EDIT_FEATURES] },
        scale: { type: "string" },
        domain: { type: "string" },
      },
      required: ["file", "userId", "feature"],
    },
  })
  @Public()
  @Post("jobs")
  @UseInterceptors(
    FileInterceptor("file", {
      storage: memoryStorage(),
      limits: { fileSize: IMAGE_EDIT_MAX_UPLOAD_BYTES },
    }),
  )
  submit(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() body: { userId?: string; feature?: string; scale?: string; domain?: string },
  ) {
    const userId = (body.userId ?? "").trim();
    if (!USER_ID_RE.test(userId)) {
      throw new BadRequestException("userId không hợp lệ");
    }
    if (!file) {
      throw new BadRequestException("Thiếu file ảnh");
    }
    return this.imageEditService.submit({
      userId,
      feature: (body.feature ?? "").trim(),
      scale: body.scale,
      domain: body.domain,
      originalName: file.originalname || "image.png",
      bytes: file.buffer,
    });
  }

  @ApiOperation({ summary: "List image-edit history for one feature" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "feature", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get("histories")
  async list(
    @Query("userId") userId?: string,
    @Query("feature") feature?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    if (!userId || !USER_ID_RE.test(userId)) {
      throw new BadRequestException("userId không hợp lệ");
    }
    if (!feature || !(IMAGE_EDIT_FEATURES as readonly string[]).includes(feature)) {
      throw new BadRequestException("feature không hợp lệ");
    }
    const result = await this.historyService.list(
      userId,
      feature as (typeof IMAGE_EDIT_FEATURES)[number],
      page ? Number(page) : 1,
      limit ? Number(limit) : 12,
    );
    return {
      items: result.items.map((row) => this.historyService.mapForClient(row)),
      total: result.total,
      page: result.page,
      limit: result.limit,
      hasMore: result.hasMore,
    };
  }

  @ApiOperation({ summary: "Get one image-edit history row" })
  @Public()
  @Get("histories/:id")
  async getOne(@Param("id") id: string) {
    const row = await this.historyService.getById(id);
    if (!row) {
      throw new BadRequestException("Không tìm thấy lịch sử");
    }
    return this.historyService.mapForClient(row);
  }

  @ApiOperation({ summary: "Serve an input or result file for an image-edit job" })
  @Public()
  @Get("files/:id/:filename")
  async serve(@Param("id") id: string, @Param("filename") filename: string, @Res() res: Response) {
    const row = await this.historyService.getById(id);
    if (!row) {
      throw new BadRequestException("Không tìm thấy lịch sử");
    }
    const abs = this.historyService.resolveFile(row, filename);
    res.setHeader("Content-Type", this.historyService.contentType(filename));
    res.setHeader("Cache-Control", "private, max-age=3600");
    if (filename.toLowerCase().endsWith(".zip")) {
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    }
    return res.sendFile(abs);
  }
}
