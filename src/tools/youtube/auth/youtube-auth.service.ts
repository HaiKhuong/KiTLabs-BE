import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { GoogleOAuthService } from "./google-oauth.service";
import { YouTubeApiService } from "../services/youtube-api.service";

@Injectable()
export class YouTubeAuthService {
  private readonly logger = new Logger(YouTubeAuthService.name);

  constructor(
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    private readonly googleOAuth: GoogleOAuthService,
    private readonly youtubeApi: YouTubeApiService,
  ) {}

  getGoogleAuthUrl(userId?: string): string {
    return this.googleOAuth.getAuthUrl(userId);
  }

  async handleCallback(code: string, userId: string): Promise<void> {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }

    const tokens = await this.googleOAuth.getTokensFromCode(code);

    if (!tokens.access_token) {
      throw new BadRequestException("Failed to get access token from Google");
    }

    const channels = await this.youtubeApi.listChannels(tokens.access_token);

    for (const channel of channels) {
      const existing = await this.channelRepo.findOne({
        where: { channelId: channel.id },
      });

      if (existing) {
        existing.googleAccessToken = tokens.access_token;
        existing.googleRefreshToken = tokens.refresh_token ?? existing.googleRefreshToken;
        existing.tokenExpiresAt = tokens.expiry_date ? new Date(tokens.expiry_date) : null;
        existing.name = channel.title;
        existing.thumbnail = channel.thumbnail;
        existing.subscriberCount = channel.subscriberCount;
        existing.videoCount = channel.videoCount;
        existing.viewCount = String(channel.viewCount);
        existing.userId = userId;
        await this.channelRepo.save(existing);
      } else {
        const newChannel = this.channelRepo.create({
          channelId: channel.id,
          name: channel.title,
          thumbnail: channel.thumbnail,
          subscriberCount: channel.subscriberCount,
          videoCount: channel.videoCount,
          viewCount: String(channel.viewCount),
          googleAccessToken: tokens.access_token,
          googleRefreshToken: tokens.refresh_token ?? null,
          tokenExpiresAt: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
          userId,
          isActive: false,
        });
        await this.channelRepo.save(newChannel);
      }
    }

    await this.ensureActiveChannel(userId);
  }

  private async ensureActiveChannel(userId: string): Promise<void> {
    const active = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (active) return;

    const first = await this.channelRepo.findOne({
      where: { userId },
      order: { createdAt: "ASC" },
    });
    if (!first) return;

    await this.channelRepo.update({ userId }, { isActive: false });
    first.isActive = true;
    await this.channelRepo.save(first);
  }

  async getUserChannels(userId: string): Promise<YouTubeChannel[]> {
    return this.channelRepo.find({
      where: { userId },
      select: ["id", "channelId", "name", "thumbnail", "subscriberCount", "videoCount", "isActive", "createdAt"],
    });
  }

  async selectChannel(userId: string, channelId: string): Promise<YouTubeChannel> {
    await this.channelRepo.update({ userId }, { isActive: false });

    const channel = await this.channelRepo.findOne({
      where: { channelId, userId },
    });

    if (!channel) {
      throw new BadRequestException("Channel not found");
    }

    channel.isActive = true;
    return this.channelRepo.save(channel);
  }

  async getActiveChannel(userId: string): Promise<YouTubeChannel | null> {
    const active = await this.channelRepo.findOne({
      where: { userId, isActive: true },
    });
    if (active) return active;

    await this.ensureActiveChannel(userId);
    return this.channelRepo.findOne({ where: { userId, isActive: true } });
  }

  async getConnectionStatus(userId: string) {
    const channel = await this.getActiveChannel(userId);
    return {
      connected: !!channel,
      channel: channel
        ? {
            id: channel.channelId,
            name: channel.name,
            thumbnail: channel.thumbnail,
            subscriberCount: channel.subscriberCount,
          }
        : null,
    };
  }

  async getValidAccessToken(channel: YouTubeChannel): Promise<string> {
    const isExpired = await this.googleOAuth.isTokenExpired(channel.tokenExpiresAt);

    if (!isExpired && channel.googleAccessToken) {
      return channel.googleAccessToken;
    }

    if (!channel.googleRefreshToken) {
      throw new BadRequestException("No refresh token available. Please re-authenticate.");
    }

    const credentials = await this.googleOAuth.refreshAccessToken(channel.googleRefreshToken);
    channel.googleAccessToken = credentials.access_token ?? null;
    channel.tokenExpiresAt = credentials.expiry_date ? new Date(credentials.expiry_date) : null;
    await this.channelRepo.save(channel);

    return channel.googleAccessToken!;
  }
}
