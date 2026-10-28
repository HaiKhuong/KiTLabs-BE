import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { isAppPlatform } from "../../common/desktop/request-platform";
import { buildOAuthAppRedirect } from "../common/platform.util";
import { PlatformTikTokService } from "./platform-tiktok.service";

type AuthUser = { userId: string };

@ApiTags("Platform TikTok")
@ApiBearerAuth("bearer")
@Controller("platform/tiktok")
export class PlatformTikTokController {
  constructor(private readonly service: PlatformTikTokService) {}

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
      response.redirect(302, buildOAuthAppRedirect("tiktok", { status: "success", ticket: completed.ticket }));
    } catch {
      response.redirect(302, buildOAuthAppRedirect("tiktok", { status: "error" }));
    }
  }

  @Public()
  @Post("handoff/redeem")
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  redeemHandoff(@Body("ticket") ticket: string) {
    return this.service.redeemHandoff(ticket);
  }

  @Post("handoff/import")
  importHandoff(
    @CurrentUser() user: AuthUser,
    @Body() body: { apiServerUrl: string; ticket: string },
  ) {
    this.desktopOnly();
    return this.service.importHandoff(user.userId, body.apiServerUrl, body.ticket);
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

  private desktopOnly(): void {
    if (!isAppPlatform()) {
      throw new ForbiddenException("TikTok Platform chỉ có trên KiTLabs Desktop");
    }
  }
}

