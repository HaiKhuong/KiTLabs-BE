import { Body, Controller, Get, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiProduces, ApiQuery, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { GenerateVeoVideoDto } from "./dto/generate-veo-video.dto";
import { GeminiVeoService } from "./gemini-veo.service";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos/veo")
export class VideosController {
  constructor(private readonly geminiVeoService: GeminiVeoService) {}

  @ApiOperation({ summary: "Gemini Veo parameter capabilities and constraints for UI" })
  @Public()
  @Get("capabilities")
  getCapabilities() {
    return this.geminiVeoService.getCapabilities();
  }

  @ApiOperation({
    summary: "Start a Gemini Veo text/image/reference-image video generation operation",
  })
  @Public()
  @Post("generate")
  generate(@Body() dto: GenerateVeoVideoDto) {
    return this.geminiVeoService.generate(dto);
  }

  @ApiOperation({ summary: "Get a Gemini Veo long-running operation status" })
  @ApiQuery({ name: "operationName", required: true })
  @ApiQuery({ name: "apiKeyTier", enum: ["normal", "vip"], required: false })
  @Public()
  @Get("operations/status")
  getOperation(@Query("operationName") operationName: string, @Query("apiKeyTier") apiKeyTier?: string) {
    return this.geminiVeoService.getOperation(operationName, apiKeyTier);
  }

  @ApiOperation({ summary: "Proxy-download a completed Gemini Veo MP4 result" })
  @ApiProduces("video/mp4")
  @ApiQuery({ name: "operationName", required: true })
  @ApiQuery({ name: "apiKeyTier", enum: ["normal", "vip"], required: false })
  @Public()
  @Get("operations/video")
  async downloadVideo(
    @Query("operationName") operationName: string,
    @Query("apiKeyTier") apiKeyTier: string | undefined,
    @Res() response: Response,
  ) {
    const result = await this.geminiVeoService.downloadGeneratedVideo(operationName, apiKeyTier);
    response.setHeader("Content-Type", result.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${result.fileName}"`);
    if (result.contentLength) {
      response.setHeader("Content-Length", result.contentLength);
    }
    return result.stream.pipe(response);
  }
}
