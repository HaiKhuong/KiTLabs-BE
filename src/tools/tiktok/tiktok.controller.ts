import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { isAppPlatform } from "../../common/desktop/request-platform";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
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
  constructor(
    private readonly service: TikTokService,
    private readonly realtime: ToolsRealtimeGateway,
  ) {}

  @Get("accounts")
  accounts(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.listAccounts(user.userId);
  }

  @Post("connect")
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  connect(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.connect(user.userId);
  }

  @Public()
  @Get("callback")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async callback(
    @Query("state") state: string | undefined,
    @Query("code") code: string | undefined,
    @Query("error") error: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    try {
      const completed = await this.service.completeOAuth({ state, code, error });
      this.realtime.notifyUser(completed.userId, "tiktok.account.connected", {
        account: completed.account,
      });
      response
        .status(200)
        .type("html")
        .send(
          "<!doctype html><meta charset=utf-8><title>KiTLabs</title><p>Đã kết nối TikTok. Bạn có thể đóng cửa sổ này.</p>",
        );
    } catch {
      response
        .status(400)
        .type("html")
        .send(
          "<!doctype html><meta charset=utf-8><title>KiTLabs</title><p>Không thể kết nối TikTok. Hãy quay lại KiTLabs và thử lại.</p>",
        );
    }
  }

  @Post("accounts/:id/refresh")
  refresh(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.refreshAccount(user.userId, id);
  }

  @Delete("accounts/:id")
  disconnect(@CurrentUser() user: AuthUser, @Param("id") id: string) {
    this.desktopOnly();
    return this.service.disconnect(user.userId, id);
  }

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
