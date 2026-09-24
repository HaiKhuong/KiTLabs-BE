import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Req, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Request, Response } from "express";
import { createReadStream, existsSync, statSync } from "fs";
import { basename } from "path";

import { Public } from "../../common/decorators/public.decorator";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateCompareSubtitleDto } from "./dto/translate-compare-subtitle.dto";
import { GeminiSubtitleTranslateService } from "./gemini-subtitle-translate.service";
import { TranslateService } from "./translate.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";

@ApiTags("Translates")
@ApiBearerAuth("bearer")
@Controller("tools/translates")
export class TranslateController {
  constructor(
    private readonly translateService: TranslateService,
    private readonly geminiSubtitleTranslateService: GeminiSubtitleTranslateService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {}

  @ApiOperation({ summary: "Create translate queue job" })
  @ApiBody({ type: CreateTranslateJobDto })
  @Public()
  @Post()
  async enqueue(@Body() dto: CreateTranslateJobDto) {
    return this.translateService.enqueue(dto);
  }

  @ApiOperation({ summary: "Translate compare-subtitle missing blocks via Gemini (zh -> vi)" })
  @ApiBody({ type: TranslateCompareSubtitleDto })
  @Public()
  @Post("compare-subtitle/translate")
  async translateCompareSubtitle(@Body() dto: TranslateCompareSubtitleDto) {
    const blocks = await this.geminiSubtitleTranslateService.translateBlocks(
      dto.blocks,
      dto.translationContext,
    );
    const srtText = blocks
      .map((b) => `${b.index}\n${b.timestamp}\n${b.text}`)
      .join("\n\n")
      .concat("\n");
    return { blocks, srtText };
  }

  @ApiOperation({ summary: "Get user translate history" })
  @ApiQuery({ name: "userId", required: true, description: "User UUID" })
  @Public()
  @Get("histories")
  async history(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.translateService.getHistory(userId);
  }

  @ApiOperation({ summary: "Stream completed Media history video (range requests)" })
  @Public()
  @Get("histories/:id/video")
  async streamHistoryVideo(@Param("id") id: string, @Req() req: Request, @Res() res: Response) {
    const history = await this.translateService.getById(id);
    if (!history) {
      throw new NotFoundException("Translate history not found");
    }
    const filePath = this.translateService.resolvePlayableVideoPath(history);
    if (!filePath || !existsSync(filePath)) {
      throw new NotFoundException("Artifact not found");
    }

    const { size: fileSize } = statSync(filePath);
    const fileName = history.resultFileName || basename(filePath);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length, Content-Type");

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

  @ApiOperation({ summary: "Cancel a running translate render" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Post("histories/:id/cancel")
  async cancel(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) throw new BadRequestException("userId is required");
    const result = await this.translateService.cancel(id, userId);
    this.realtimeGateway.notifyUser(userId, "translate.cancelled", {
      translateHistoryId: id,
      cancelled: true,
      deletedFiles: result.deletedFiles,
      terminal: true,
    });
    return result;
  }

  @ApiOperation({ summary: "Get translate artifact by result path" })
  @ApiQuery({ name: "resultPath", required: true, description: "Absolute result video path" })
  @ApiQuery({
    name: "type",
    required: true,
    description: "Artifact type: zh | vi | audio | video",
  })
  @Public()
  @Get("artifact")
  async artifact(
    @Query("resultPath") resultPath: string | undefined,
    @Query("type") type: string | undefined,
    @Res() res: Response,
  ) {
    if (!resultPath) {
      throw new BadRequestException("resultPath is required");
    }

    const parsedType = this.translateService.parseArtifactType(type);
    const artifact = this.translateService.resolveArtifact(resultPath, parsedType);

    res.setHeader("Content-Type", artifact.contentType);
    return res.sendFile(artifact.absolutePath);
  }

  @ApiOperation({ summary: "Check if the translate work folder exists for a video file name" })
  @ApiQuery({ name: "fileName", required: true, description: "Video file name, e.g. thebaip1.mp4" })
  @Public()
  @Get("workspace-status")
  async workspaceStatus(@Query("fileName") fileName?: string) {
    if (!fileName?.trim()) {
      throw new BadRequestException("fileName is required");
    }
    return this.translateService.statWorkspaceByFileName(fileName);
  }

  @ApiOperation({ summary: "Load zh/vi SRT + cue voices from a previous translate work folder by video file name" })
  @ApiQuery({ name: "fileName", required: true, description: "Video file name, e.g. thebaip1.mp4" })
  @Public()
  @Get("workspace")
  async workspace(@Query("fileName") fileName?: string) {
    if (!fileName?.trim()) {
      throw new BadRequestException("fileName is required");
    }
    return this.translateService.loadWorkspaceByFileName(fileName);
  }

  @ApiOperation({ summary: "Stream a per-cue TTS wav (logs/tts_chunks/part_XXXX.wav)" })
  @ApiQuery({ name: "fileName", required: true })
  @ApiQuery({ name: "index", required: true, description: "0-based SRT block index" })
  @Public()
  @Get("cue-voice")
  async cueVoice(
    @Query("fileName") fileName: string | undefined,
    @Query("index") indexRaw: string | undefined,
    @Res() res: Response,
  ) {
    if (!fileName?.trim()) {
      throw new BadRequestException("fileName is required");
    }
    const index = Number(indexRaw);
    if (!Number.isFinite(index) || index < 0) {
      throw new BadRequestException("index must be a non-negative number");
    }
    const artifact = this.translateService.resolveCueVoice(fileName, index);
    res.setHeader("Content-Type", artifact.contentType);
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(artifact.absolutePath);
  }

  @ApiOperation({ summary: "Read runtime pipeline log by history id or video file name" })
  @ApiQuery({ name: "translateHistoryId", required: false, description: "Translate history UUID" })
  @ApiQuery({ name: "fileName", required: false, description: "Source video file name (workspace folder)" })
  @ApiQuery({
    name: "tailLines",
    required: false,
    description: "Return latest N lines only (default 200, max 2000)",
  })
  @Public()
  @Get("runtime-log")
  async runtimeLog(
    @Query("translateHistoryId") translateHistoryId: string | undefined,
    @Query("fileName") fileName: string | undefined,
    @Query("tailLines") tailLinesRaw: string | undefined,
  ) {
    if (!translateHistoryId && !fileName) {
      throw new BadRequestException("translateHistoryId or fileName is required");
    }

    const tailLines =
      typeof tailLinesRaw === "string" && tailLinesRaw.trim().length > 0 ? Number(tailLinesRaw.trim()) : undefined;
    return this.translateService.readRuntimeLog({ translateHistoryId, fileName, tailLines });
  }
}
