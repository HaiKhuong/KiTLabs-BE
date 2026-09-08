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
import {
  CreateNarratoJobDto,
  RunNarratoStepDto,
  UpdateNarratoScriptDto,
  UpdateNarratoTextDto,
} from "./dto/create-narrato-job.dto";
import { NarratoService } from "./narrato.service";
import { isNarratoStepId } from "./narrato-steps.constants";

@ApiTags("Narrato")
@ApiBearerAuth("bearer")
@Controller("tools/narrato")
export class NarratoController {
  constructor(private readonly narratoService: NarratoService) {}

  @ApiOperation({ summary: "Create a narrato project" })
  @Public()
  @Post()
  async create(@Body() dto: CreateNarratoJobDto) {
    const created = await this.narratoService.enqueue(dto);
    return {
      narratoHistoryId: created.id,
      status: created.status,
      displayName: created.displayName,
      stepProgress: created.engineConfig?.narratoStepProgress ?? null,
    };
  }

  @ApiOperation({ summary: "Run a single narrato pipeline step" })
  @Public()
  @Post("histories/:id/run-step")
  async runStep(@Param("id") id: string, @Body() dto: RunNarratoStepDto) {
    const step = String(dto.step || "").trim();
    if (!isNarratoStepId(step)) {
      throw new NotFoundException("Invalid step. Use: ingest, plot, copy, match, mix, render");
    }
    const queued = await this.narratoService.enqueueStep(id, step);
    return {
      narratoHistoryId: queued.id,
      status: queued.status,
      step,
      stepProgress: queued.engineConfig?.narratoStepProgress ?? null,
    };
  }

  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Get("histories")
  async histories(@Query("userId") userId: string) {
    if (!userId) throw new NotFoundException("userId is required");
    const rows = await this.narratoService.getHistory(userId);
    return rows.map((row) => this.narratoService.mapHistoryForClient(row));
  }

  @Public()
  @Get("histories/:id")
  async getOne(@Param("id") id: string) {
    const row = await this.narratoService.getById(id);
    if (!row) throw new NotFoundException("Narrato job not found");
    return this.narratoService.mapHistoryForClient(row);
  }

  @Public()
  @Patch("histories/:id/script")
  async updateScript(@Param("id") id: string, @Body() dto: UpdateNarratoScriptDto) {
    const saved = await this.narratoService.updateScriptPayload(id, dto.scriptPayload);
    return this.narratoService.mapHistoryForClient(saved);
  }

  @Public()
  @Patch("histories/:id/plot")
  async updatePlot(@Param("id") id: string, @Body() dto: UpdateNarratoTextDto) {
    const saved = await this.narratoService.updatePlot(id, dto.text);
    return this.narratoService.mapHistoryForClient(saved);
  }

  @Public()
  @Patch("histories/:id/copy")
  async updateCopy(@Param("id") id: string, @Body() dto: UpdateNarratoTextDto) {
    const saved = await this.narratoService.updateCopy(id, dto.text);
    return this.narratoService.mapHistoryForClient(saved);
  }

  @ApiQuery({ name: "narratoHistoryId", required: true })
  @Public()
  @Get("runtime-log")
  async runtimeLog(@Query("narratoHistoryId") narratoHistoryId: string) {
    if (!narratoHistoryId) throw new NotFoundException("narratoHistoryId is required");
    const row = await this.narratoService.getById(narratoHistoryId);
    if (!row) throw new NotFoundException("Narrato job not found");
    return { log: this.narratoService.getRuntimeLog(row) };
  }

  @ApiQuery({ name: "narratoHistoryId", required: true })
  @ApiQuery({ name: "type", required: false, enum: ["video", "script", "plot", "copy"] })
  @Public()
  @Get("artifact")
  async artifact(
    @Query("narratoHistoryId") narratoHistoryId: string,
    @Query("type") type: "video" | "script" | "plot" | "copy" = "video",
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!narratoHistoryId) throw new NotFoundException("narratoHistoryId is required");
    const history = await this.narratoService.getById(narratoHistoryId);
    if (!history) throw new NotFoundException("Narrato job not found");

    const filePath = this.narratoService.resolveArtifactPath(history, type);
    if (!existsSync(filePath)) throw new NotFoundException("Artifact not found");

    const ext = extname(filePath).toLowerCase();
    const contentType =
      type === "video" || ext === ".mp4"
        ? "video/mp4"
        : ext === ".json"
          ? "application/json"
          : "text/plain; charset=utf-8";

    const { size: fileSize } = statSync(filePath);
    const isVideo = type === "video" || ext === ".mp4";

    if (isVideo) {
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${history.resultFileName ?? "narrato.mp4"}"`,
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

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(fileSize));
    return createReadStream(filePath).pipe(res);
  }
}
