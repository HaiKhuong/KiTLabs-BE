import { BadRequestException, Body, Controller, Post, Res } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { YtdlpDownloadDto } from "./dto/ytdlp-download.dto";
import { YtdlpInfoDto } from "./dto/ytdlp-info.dto";
import { YtdlpPlaylistDto } from "./dto/ytdlp-playlist.dto";
import { YtdlpService } from "./ytdlp.service";

@ApiTags("yt-dlp")
@Controller("tools/ytdlp")
export class YtdlpController {
  constructor(private readonly ytdlpService: YtdlpService) {}

  @ApiOperation({ summary: "Extract media metadata via yt-dlp" })
  @ApiBody({ type: YtdlpInfoDto })
  @Public()
  @Post("info")
  async info(@Body() dto: YtdlpInfoDto) {
    return this.ytdlpService.getInfo(dto.url);
  }

  @ApiOperation({ summary: "Expand playlist URLs via yt-dlp" })
  @ApiBody({ type: YtdlpPlaylistDto })
  @Public()
  @Post("playlist")
  async playlist(@Body() dto: YtdlpPlaylistDto) {
    const urls = await this.ytdlpService.expandPlaylist(dto.url);
    return { urls };
  }

  @ApiOperation({ summary: "Download media via yt-dlp (video mp4 or audio mp3)" })
  @ApiBody({ type: YtdlpDownloadDto })
  @Public()
  @Post("download")
  async download(@Body() dto: YtdlpDownloadDto, @Res() res: Response) {
    try {
      const streamResponse = await this.ytdlpService.download(
        dto.url,
        dto.format ?? "video",
        dto.formatId,
      );
      const contentDisposition = streamResponse.headers["content-disposition"] as string | undefined;
      const contentType =
        (streamResponse.headers["content-type"] as string) || "application/octet-stream";
      const fallbackName = dto.format === "audio" ? "audio.mp3" : "video.mp4";

      res.setHeader("Content-Type", contentType);
      res.setHeader(
        "Content-Disposition",
        contentDisposition || `attachment; filename="${fallbackName}"`,
      );
      streamResponse.data.pipe(res);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Download failed";
      throw new BadRequestException(message);
    }
  }
}
