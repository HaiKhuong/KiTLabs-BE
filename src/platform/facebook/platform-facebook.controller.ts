import {
  Body,
  Controller,
  ForbiddenException,
  Get,
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
import { PlatformFacebookService } from "./platform-facebook.service";

type AuthUser = { userId: string };

@ApiTags("Platform Facebook")
@ApiBearerAuth("bearer")
@Controller("platform/facebook")
export class PlatformFacebookController {
  constructor(private readonly service: PlatformFacebookService) {}

  @Get("connection")
  connection(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.connection(user.userId);
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
      response.redirect(302, buildOAuthAppRedirect("facebook", { status: "success", ticket: completed.ticket }));
    } catch {
      response.redirect(302, buildOAuthAppRedirect("facebook", { status: "error" }));
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

  @Post("disconnect")
  disconnect(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.disconnect(user.userId);
  }

  @Post("connection/check")
  check(@CurrentUser() user: AuthUser) {
    this.desktopOnly();
    return this.service.checkConnection(user.userId);
  }

  private desktopOnly(): void {
    if (!isAppPlatform()) {
      throw new ForbiddenException("Facebook Platform chỉ có trên KiTLabs Desktop");
    }
  }
}

