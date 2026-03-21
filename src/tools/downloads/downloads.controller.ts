import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { DownloadsService } from "./downloads.service";
import { CreateDownloadDto } from "./dto/create-download.dto";
import { DownloadVideosDto } from "./dto/download-videos.dto";
import { ImportVideoListDto } from "./dto/import-video-list.dto";
import { UpdateVideoFilenameDto } from "./dto/update-video-filename.dto";

@ApiTags("Downloads")
@Controller("tools/downloads")
export class DownloadsController {
  constructor(private readonly downloadsService: DownloadsService) {}

  @ApiOperation({ summary: "Create download history from source" })
  @ApiBody({ type: CreateDownloadDto })
  @Post()
  async create(@Body() dto: CreateDownloadDto) {
    return this.downloadsService.create(dto);
  }

  @ApiOperation({ summary: "Get current user download history" })
  @Get("history")
  async getHistory(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.downloadsService.histories(user.userId);
  }

  @ApiOperation({ summary: "Import video list from txt content" })
  @ApiBody({ type: ImportVideoListDto })
  @Public()
  @Post("videos/import")
  async importVideoList(@Body() dto: ImportVideoListDto) {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    return this.downloadsService.importVideoList(dto.userId, dto);
  }

  @ApiOperation({ summary: "Get all video downloads for current user" })
  @Public()
  @Get("videos")
  async getVideoDownloads(@Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.downloadsService.getVideoDownloads(userId);
  }

  @ApiOperation({ summary: "Update video filename" })
  @ApiBody({ type: UpdateVideoFilenameDto })
  @Public()
  @Patch("videos/:id/filename")
  async updateVideoFilename(
    @Query("userId") userId: string | undefined,
    @Param("id") videoId: string,
    @Body() dto: UpdateVideoFilenameDto,
  ) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.downloadsService.updateVideoFilename(userId, videoId, dto);
  }

  @ApiOperation({ summary: "Download multiple videos using Gopeed" })
  @ApiBody({ type: DownloadVideosDto })
  @Public()
  @Post("videos/download")
  async downloadVideos(@Body() dto: DownloadVideosDto) {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    return this.downloadsService.downloadVideos(dto.userId, dto);
  }

  @ApiOperation({ summary: "Delete video downloads" })
  @Public()
  @Delete("videos")
  async deleteVideos(@Body() body: { userId: string; videoIds: string[] }) {
    if (!body.userId) {
      throw new BadRequestException("userId is required");
    }
    return this.downloadsService.deleteVideoDownloads(body.userId, body.videoIds);
  }
}
