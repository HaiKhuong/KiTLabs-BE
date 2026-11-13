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
import { existsSync, readFileSync } from "fs";
import { extname } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { streamMediaFileNonLocking } from "../../common/http/stream-media-non-locking";
import { CreateRecapJobDto, RunRecapStepDto, UpdateRecapScriptDto } from "./dto/create-recap-job.dto";
import { RecapService } from "./recap.service";
import { isRecapStepId } from "./recap-steps.constants";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";

@ApiTags("Recap")
@ApiBearerAuth("bearer")
@Controller("tools/recap")
export class RecapController {
  constructor(
    private readonly recapService: RecapService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {}

  @ApiOperation({ summary: "Create a recap project (upload config, no auto-run)" })
  @Public()
  @Post()
  async create(@Body() dto: CreateRecapJobDto) {
    const created = await this.recapService.enqueue(dto);
    return {
      recapHistoryId: created.id,
      status: created.status,
      displayName: created.displayName,
      stepProgress: created.engineConfig?.recapStepProgress ?? null,
    };
  }

  @ApiOperation({ summary: "Run a single recap pipeline step" })
  @Public()
  @Post("histories/:id/run-step")
  async runStep(@Param("id") id: string, @Body() dto: RunRecapStepDto) {
    const step = String(dto.step || "").trim();
    if (!isRecapStepId(step)) {
      throw new NotFoundException(
        "Invalid step. Use: asr, scenes, cluster, call_a1, candidates, vlm, call_a2, tts, call_b, render",
      );
    }
    const queued = await this.recapService.enqueueStep(id, step);
    return {
      recapHistoryId: queued.id,
      status: queued.status,
      step,
      stepProgress: queued.engineConfig?.recapStepProgress ?? null,
    };
  }

  @ApiOperation({ summary: "Cancel the running recap step" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Post("histories/:id/cancel")
  async cancel(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new NotFoundException("userId is required");
    const before = await this.recapService.getById(id);
    const step = before ? this.recapService.mapHistoryForClient(before).stepProgress?.runningStep : null;
    const result = await this.recapService.cancel(id, userId);
    const row = await this.recapService.getById(id);
    this.realtimeGateway.notifyUser(userId, "recap.cancelled", {
      recapHistoryId: id,
      cancelled: true,
      deletedFiles: result.deletedFiles,
      terminal: true,
      step,
      stepProgress: row ? this.recapService.mapHistoryForClient(row).stepProgress : null,
    });
    return result;
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
  async runtimeLog(@Query("recapHistoryId") recapHistoryId: string) {
    if (!recapHistoryId) throw new NotFoundException("recapHistoryId is required");
    const row = await this.recapService.getById(recapHistoryId);
    if (!row) throw new NotFoundException("Recap job not found");
    return { log: this.recapService.getRuntimeLog(row) };
  }

  @ApiOperation({ summary: "Get step artifact payload for review UI" })
  @Public()
  @Get("histories/:id/step-artifact")
  async stepArtifact(@Param("id") id: string, @Query("step") stepRaw?: string) {
    const step = String(stepRaw || "").trim();
    if (!isRecapStepId(step)) {
      throw new NotFoundException(
        "Invalid step. Use: asr, scenes, cluster, call_a1, candidates, vlm, call_a2, tts, call_b, render",
      );
    }
    const row = await this.recapService.getById(id);
    if (!row) throw new NotFoundException("Recap job not found");
    return this.recapService.getStepArtifact(row, step);
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

    const isVideo = type === "video" || ext === ".mp4";

    if (isVideo) {
      return streamMediaFileNonLocking(filePath, req, res, {
        contentType,
        fileName: history.resultFileName ?? "recap.mp4",
      });
    }

    const buf = readFileSync(filePath);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(buf.length));
    return res.end(buf);
  }
}
