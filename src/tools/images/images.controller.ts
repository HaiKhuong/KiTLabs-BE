import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { GenerateStudioImageDto } from "./dto/generate-studio-image.dto";
import { VideosImageService } from "../videos/videos-image.service";

@ApiTags("Images")
@ApiBearerAuth("bearer")
@Controller("tools/images")
export class ImagesController {
  constructor(private readonly videosImageService: VideosImageService) {}

  @ApiOperation({ summary: "Generate a single image from text prompt (FLUX Schnell, sync)" })
  @ApiBody({ type: GenerateStudioImageDto })
  @Public()
  @Post("generate")
  async generate(@Body() dto: GenerateStudioImageDto) {
    return this.videosImageService.generateStudioImage(dto);
  }

  @ApiOperation({ summary: "Serve generated studio image PNG" })
  @Public()
  @Get(":userId/:jobId/:filename")
  async serveImage(
    @Param("userId") userId: string,
    @Param("jobId") jobId: string,
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    const abs = this.videosImageService.resolveImageFilePath(userId, jobId, filename);
    if (!abs) {
      throw new NotFoundException("Image not found");
    }
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.sendFile(abs);
  }
}
