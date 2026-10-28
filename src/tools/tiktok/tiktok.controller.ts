import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { isAppPlatform } from "../../common/desktop/request-platform";
import {
  ImportLocalVideoDto,
  PublishTikTokVideoDto,
  TikTokVideoListQueryDto,
  VideoHistoryQueryDto,
} from "./tiktok.types";
import { TikTokService } from "./tiktok.service";

type AuthUser = { userId: string };

@ApiTags("TikTok")
@ApiBearerAuth("bearer")
@Controller("tiktok")
export class TikTokController {
  constructor(private readonly service: TikTokService) {}

  @Get("creator-info/:accountId")
  creatorInfo(@CurrentUser() user: AuthUser, @Param("accountId") accountId: string) {
    this.desktopOnly();
    return this.service.creatorInfo(user.userId, accountId);
  }

  @Get("videos/:accountId")
  videos(
    @CurrentUser() user: AuthUser,
    @Param("accountId") accountId: string,
    @Query() query: TikTokVideoListQueryDto,
  ) {
    this.desktopOnly();
    return this.service.listProviderVideos(user.userId, accountId, query);
  }

  private desktopOnly(): void {
    if (!isAppPlatform()) throw new ForbiddenException("TikTok Publisher is available in KiTLabs Desktop only");
  }
}

@ApiTags("TikTok videos")
@ApiBearerAuth("bearer")
@Controller("videos")
export class TikTokVideosController {
  constructor(private readonly service: TikTokService) {}

  @Post("upload")
  upload(@CurrentUser() user: AuthUser, @Body() dto: ImportLocalVideoDto) {
    this.desktopOnly();
    return this.service.importLocalVideo(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: VideoHistoryQueryDto) {
    this.desktopOnly();
    return this.service.listHistory(user.userId, query);
  }

  @Get(":id")
  get(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.getHistory(user.userId, id);
  }

  @Post(":id/publish")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  publish(@CurrentUser() user: AuthUser, @Param("id") id: string, @Body() dto: PublishTikTokVideoDto) {
    this.desktopOnly();
    return this.service.publish(user.userId, id, dto);
  }

  @Post(":id/retry")
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  retry(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.retry(user.userId, id);
  }

  private desktopOnly(): void {
    if (!isAppPlatform()) throw new ForbiddenException("TikTok Publisher is available in KiTLabs Desktop only");
  }
}
