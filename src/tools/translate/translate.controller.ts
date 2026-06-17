import { BadRequestException, Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateCompareSubtitleDto } from "./dto/translate-compare-subtitle.dto";
import { GeminiSubtitleTranslateService } from "./gemini-subtitle-translate.service";
import { TranslateService } from "./translate.service";

@ApiTags("Translates")
@ApiBearerAuth("bearer")
@Controller("tools/translates")
export class TranslateController {
  constructor(
    private readonly translateService: TranslateService,
    private readonly geminiSubtitleTranslateService: GeminiSubtitleTranslateService,
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

  @ApiOperation({ summary: "Read runtime pipeline log by translate history id" })
  @ApiQuery({ name: "translateHistoryId", required: true, description: "Translate history UUID" })
  @ApiQuery({
    name: "tailLines",
    required: false,
    description: "Return latest N lines only (default 200, max 2000)",
  })
  @Public()
  @Get("runtime-log")
  async runtimeLog(
    @Query("translateHistoryId") translateHistoryId: string | undefined,
    @Query("tailLines") tailLinesRaw: string | undefined,
  ) {
    if (!translateHistoryId) {
      throw new BadRequestException("translateHistoryId is required");
    }

    const tailLines =
      typeof tailLinesRaw === "string" && tailLinesRaw.trim().length > 0 ? Number(tailLinesRaw.trim()) : undefined;
    return this.translateService.readRuntimeLog({ translateHistoryId, tailLines });
  }
}
