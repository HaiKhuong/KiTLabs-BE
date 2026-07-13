import { BadRequestException, Body, Controller, Post, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { DouyinService } from "./douyin.service";
import { DownloadDouyinDto } from "./dto/download-douyin.dto";
import { ExtractDouyinDto } from "./dto/extract-douyin.dto";
import { ExtractProfileDto } from "./dto/extract-profile.dto";
import { ExtractUrlDto } from "./dto/extract-url.dto";

@ApiTags("Douyin")
@Controller("tools/douyin")
export class DouyinController {
  constructor(private readonly douyinService: DouyinService) {}

  @ApiOperation({ summary: "Auto-detect video/profile URL and extract" })
  @ApiBody({ type: ExtractUrlDto })
  @Public()
  @Post("extract-url")
  async extractUrl(@Body() dto: ExtractUrlDto) {
    return this.douyinService.extractByUrl(
      dto.url,
      dto.maxVideos,
      dto.cursor ?? 0,
    );
  }

  @ApiOperation({ summary: "Extract single Douyin video info" })
  @ApiBody({ type: ExtractDouyinDto })
  @Public()
  @Post("extract")
  async extract(@Body() dto: ExtractDouyinDto) {
    return this.douyinService.extractVideo(dto.url);
  }

  @ApiOperation({ summary: "Extract videos from Douyin user profile" })
  @ApiBody({ type: ExtractProfileDto })
  @Public()
  @Post("extract-profile")
  async extractProfile(@Body() dto: ExtractProfileDto) {
    return this.douyinService.extractProfile(
      dto.url,
      dto.maxVideos,
      dto.cursor ?? 0,
    );
  }

  @ApiOperation({ summary: "Download Douyin video by format" })
  @ApiBody({ type: DownloadDouyinDto })
  @Public()
  @Post("download")
  async download(@Body() dto: DownloadDouyinDto, @Res() res: Response) {
    try {
      const streamResponse = await this.douyinService.downloadVideo(
        dto.url,
        dto.formatId,
        dto.directUrl,
      );

      const contentDisposition = streamResponse.headers["content-disposition"] as string | undefined;
      const contentType = (streamResponse.headers["content-type"] as string) || "application/octet-stream";

      res.setHeader("Content-Type", contentType);
      if (contentDisposition) {
        res.setHeader("Content-Disposition", contentDisposition);
      } else {
        res.setHeader("Content-Disposition", 'attachment; filename="video.mp4"');
      }

      streamResponse.data.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed";
      throw new BadRequestException(message);
    }
  }

  @ApiOperation({ summary: "Download video thumbnail image" })
  @Public()
  @Post("download-thumbnail")
  async downloadThumbnail(@Body() body: { thumbnailUrl: string }, @Res() res: Response) {
    if (!body.thumbnailUrl) {
      throw new BadRequestException("thumbnailUrl is required");
    }

    try {
      const streamResponse = await this.douyinService.downloadThumbnail(body.thumbnailUrl);
      const contentType = (streamResponse.headers["content-type"] as string) || "image/jpeg";

      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Disposition", 'attachment; filename="thumbnail.jpg"');

      streamResponse.data.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Thumbnail download failed";
      throw new BadRequestException(message);
    }
  }
}
