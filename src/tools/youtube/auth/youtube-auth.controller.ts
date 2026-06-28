import { BadRequestException, Controller, Get, Post, Query, Body, Res } from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../../common/decorators/public.decorator";
import { YouTubeAuthService } from "./youtube-auth.service";
import { requireUserId } from "../utils/require-user-id";

@ApiTags("YouTube Auth")
@Controller("youtube/auth")
export class YouTubeAuthController {
  constructor(private readonly youtubeAuthService: YouTubeAuthService) {}

  @Public()
  @Get("google")
  @ApiOperation({ summary: "Redirect to Google OAuth consent screen" })
  async googleAuth(@Query("userId") userId: string, @Res() res: Response) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    const url = this.youtubeAuthService.getGoogleAuthUrl(userId);
    return res.redirect(url);
  }

  @Public()
  @Get("google/callback")
  @ApiOperation({ summary: "Handle Google OAuth callback" })
  async googleCallback(
    @Query("code") code: string,
    @Query("state") state: string,
    @Res() res: Response,
  ) {
    await this.youtubeAuthService.handleCallback(code, state);
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3001";
    return res.redirect(`${frontendUrl}/tools/youtube/settings?oauth=success`);
  }

  @Public()
  @Get("channels")
  @ApiOperation({ summary: "List user YouTube channels" })
  async getChannels(@Query("userId") userId?: string) {
    return this.youtubeAuthService.getUserChannels(requireUserId(userId));
  }

  @Public()
  @Post("channels/select")
  @ApiOperation({ summary: "Select active YouTube channel" })
  async selectChannel(
    @Query("userId") userId: string | undefined,
    @Body("channelId") channelId: string,
  ) {
    return this.youtubeAuthService.selectChannel(requireUserId(userId), channelId);
  }

  @Public()
  @Get("status")
  @ApiOperation({ summary: "Check Google OAuth connection status" })
  async getStatus(@Query("userId") userId?: string) {
    return this.youtubeAuthService.getConnectionStatus(requireUserId(userId));
  }
}
