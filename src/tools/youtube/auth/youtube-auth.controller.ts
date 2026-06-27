import { Controller, Get, Post, Query, Body, Res, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";

import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { YouTubeAuthService } from "./youtube-auth.service";

@ApiTags("YouTube Auth")
@Controller("youtube/auth")
export class YouTubeAuthController {
  constructor(private readonly youtubeAuthService: YouTubeAuthService) {}

  @Get("google")
  @ApiOperation({ summary: "Redirect to Google OAuth consent screen" })
  async googleAuth(@Res() res: Response) {
    const url = this.youtubeAuthService.getGoogleAuthUrl();
    return res.redirect(url);
  }

  @Get("google/callback")
  @ApiOperation({ summary: "Handle Google OAuth callback" })
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @CurrentUser() user: { userId: string },
    @Res() res: Response,
  ) {
    await this.youtubeAuthService.handleCallback(code, user.userId);
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";
    return res.redirect(`${frontendUrl}/tools/youtube/settings?oauth=success`);
  }

  @Get("channels")
  @ApiOperation({ summary: "List user YouTube channels" })
  async getChannels(@CurrentUser() user: { userId: string }) {
    return this.youtubeAuthService.getUserChannels(user.userId);
  }

  @Post("channels/select")
  @ApiOperation({ summary: "Select active YouTube channel" })
  async selectChannel(
    @CurrentUser() user: { userId: string },
    @Body("channelId") channelId: string,
  ) {
    return this.youtubeAuthService.selectChannel(user.userId, channelId);
  }

  @Get("status")
  @ApiOperation({ summary: "Check Google OAuth connection status" })
  async getStatus(@CurrentUser() user: { userId: string }) {
    return this.youtubeAuthService.getConnectionStatus(user.userId);
  }
}
