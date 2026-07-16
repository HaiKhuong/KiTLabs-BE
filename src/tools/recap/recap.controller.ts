import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import { extname } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { CreateRecapJobDto, UpdateRecapScriptDto } from "./dto/create-recap-job.dto";
import { RecapService } from "./recap.service";

@ApiTags("Recap")
@ApiBearerAuth("bearer")
@Controller("tools/recap")
export class RecapController {
  constructor(private readonly recapService: RecapService) {}

  @ApiOperation({ summary: "Enqueue a movie recap job" })
  @Public()
  @Post()
  async create(@Body() dto: CreateRecapJobDto) {
    const created = await this.recapService.enqueue(dto);
    return {
      recapHistoryId: created.id,
      status: created.status,
      displayName: created.displayName,
      movieId: created.movieId,
    };
  }

  @ApiOperation({ summary: "List recap histories for a user" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("histories")
  async histories(@Query("userId") userId: string) {
    if (!userId) throw new NotFoundException("userId is required");
    const rows = await this.recapService.getHistory(userId);
    return rows.map((row) => this.recapService.mapHistoryForClient(row));
  }

  @ApiOperation({ summary: "Get one recap history" })
  @Public()
  @Get("histories/:id")
  async getOne(@Param("id") id: string) {
    const row = await this.recapService.getById(id);
    if (!row) throw new NotFoundException("Recap job not found");
    return this.recapService.mapHistoryForClient(row);
  }

  @ApiOperation({ summary: "Update lean script payload (human review)" })
  @Public()
  @Patch("histories/:id/script")
  async updateScript(@Param("id") id: string, @Body() dto: UpdateRecapScriptDto) {
    const saved = await this.recapService.updateScriptPayload(id, dto.scriptPayload);
    return this.recapService.mapHistoryForClient(saved);
  }

  @ApiOperation({ summary: "Tail pipeline runtime log" })
  @ApiQuery({ name: "recapHistoryId", required: true })
  @Public()
  @Get("runtime-log")
  runtimeLog(@Query("recapHistoryId") recapHistoryId: string) {
    if (!recapHistoryId) throw new NotFoundException("recapHistoryId is required");
    return { log: this.recapService.getRuntimeLog(recapHistoryId) };
  }

  @ApiOperation({ summary: "Stream recap artifact (video / script / timeline)" })
  @ApiQuery({ name: "recapHistoryId", required: true })
  @ApiQuery({ name: "type", required: false, enum: ["video", "script", "timeline"] })
  @Public()
  @Get("artifact")
  async artifact(
    @Query("recapHistoryId") recapHistoryId: string,
    @Query("type") type: "video" | "script" | "timeline" = "video",
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!recapHistoryId) throw new NotFoundException("recapHistoryId is required");
    const history = await this.recapService.getById(recapHistoryId);
    if (!history) throw new NotFoundException("Recap job not found");

    const filePath = this.recapService.resolveArtifactPath(history, type);
    if (!existsSync(filePath)) throw new NotFoundException("Artifact not found");

    const ext = extname(filePath).toLowerCase();
    const contentType =
      type === "video" || ext === ".mp4"
        ? "video/mp4"
        : ext === ".json"
          ? "application/json"
          : "application/octet-stream";

    const { size: fileSize } = statSync(filePath);
    const isVideo = type === "video" || ext === ".mp4";

    if (isVideo) {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${history.resultFileName ?? "recap.mp4"}"`,
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

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(fileSize));
    return createReadStream(filePath).pipe(res);
  }
}
