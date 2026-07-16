import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
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

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(statSync(filePath).size));
    if (type === "video") {
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${history.resultFileName ?? "recap.mp4"}"`,
      );
    }
    createReadStream(filePath).pipe(res);
  }
}
