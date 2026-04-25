import { BadRequestException, Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateService } from "./translate.service";

@ApiTags("Translates")
@ApiBearerAuth("bearer")
@Controller("tools/translates")
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}

  @ApiOperation({ summary: "Create translate queue job" })
  @ApiBody({
    type: CreateTranslateJobDto,
    examples: {
      render: {
        summary: "Render 1-6 with embedded subtitle source",
        value: {
          userId: "user-uuid",
          stepNbr: [1, 2, 3, 4, 5, 6],
          estimatedCost: 0,
          engineConfig: {
            localVideoPath: "/uploads/videos/demo.mp4",
            step1SubtitleSource: "embedded",
            edgeTtsRate: "+30%",
            edgeTtsVolume: "+10%",
            edgeTtsPitch: "+20Hz",
          },
        },
      },
    },
  })
  @Public()
  @Post()
  async enqueue(@Body() dto: CreateTranslateJobDto) {
    return this.translateService.enqueue(dto);
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
}
