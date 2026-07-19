import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { YouTubeVideo } from "../entities/youtube-video.entity";
import { AnalyticsSnapshot } from "../entities/analytics-snapshot.entity";
import { Movie } from "../entities/movie.entity";
import { YouTubeApiService } from "../services/youtube-api.service";
import { TrendsService } from "../services/trends.service";
import { RecommendationService } from "../services/recommendation.service";
import { YouTubeAuthService } from "../auth/youtube-auth.service";

/** Tạm tắt cron YouTube; đổi thành true khi bật lại scheduler. */
const YOUTUBE_CRON_ENABLED = false;

@Injectable()
export class YouTubeSchedulerService {
  private readonly logger = new Logger(YouTubeSchedulerService.name);

  constructor(
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    @InjectRepository(YouTubeVideo, "tool")
    private readonly videoRepo: Repository<YouTubeVideo>,
    @InjectRepository(AnalyticsSnapshot, "tool")
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(Movie, "tool")
    private readonly movieRepo: Repository<Movie>,
    private readonly youtubeApi: YouTubeApiService,
    private readonly trendsService: TrendsService,
    private readonly recommendationService: RecommendationService,
    private readonly authService: YouTubeAuthService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_6AM, { disabled: !YOUTUBE_CRON_ENABLED })
  async syncYouTubeAnalytics(): Promise<void> {
    this.logger.log("Starting YouTube analytics sync...");

    const channels = await this.channelRepo.find({ where: { isActive: true } });

    for (const channel of channels) {
      try {
        const accessToken = await this.authService.getValidAccessToken(channel);
        await this.syncChannelData(channel, accessToken);
        await this.syncVideos(channel, accessToken);
        await this.syncAnalyticsSnapshots(channel, accessToken);
        this.logger.log(`Synced analytics for channel: ${channel.name}`);
      } catch (error) {
        this.logger.error(`Failed to sync channel ${channel.name}: ${error}`);
      }
    }

    // Generate recommendations after sync
    const userIds = [...new Set(channels.map((c) => c.userId))];
    for (const userId of userIds) {
      try {
        await this.recommendationService.generateRecommendations(userId);
      } catch (error) {
        this.logger.error(`Failed to generate recommendations for user ${userId}: ${error}`);
      }
    }

    this.logger.log("YouTube analytics sync completed");
  }

  @Cron(CronExpression.EVERY_DAY_AT_6AM, { disabled: !YOUTUBE_CRON_ENABLED })
  async syncGoogleTrends(): Promise<void> {
    this.logger.log("Starting Google Trends sync...");

    const movies = await this.movieRepo.find();
    const moviesByUser = new Map<string, Movie[]>();

    for (const movie of movies) {
      const list = moviesByUser.get(movie.userId) ?? [];
      list.push(movie);
      moviesByUser.set(movie.userId, list);
    }

    for (const [userId, userMovies] of moviesByUser) {
      try {
        const keywords = userMovies.map((m) => m.chineseName);
        const results = await this.trendsService.fetchTrends(keywords);

        for (let i = 0; i < userMovies.length; i++) {
          const movie = userMovies[i];
          const trendResult = results[i];

          if (trendResult) {
            await this.trendsService.saveTrends(movie.id, [trendResult], "VN");
            movie.trendScore = String(trendResult.trendScore);
            await this.movieRepo.save(movie);
          }
        }

        this.logger.log(`Synced trends for ${userMovies.length} movies (user: ${userId})`);
      } catch (error) {
        this.logger.error(`Failed to sync trends for user ${userId}: ${error}`);
      }
    }

    this.logger.log("Google Trends sync completed");
  }

  async manualSyncAnalytics(userId: string): Promise<void> {
    const channel = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (!channel) return;

    const accessToken = await this.authService.getValidAccessToken(channel);
    await this.syncChannelData(channel, accessToken);
    await this.syncVideos(channel, accessToken);
    await this.syncAnalyticsSnapshots(channel, accessToken);
    await this.recommendationService.generateRecommendations(userId);
  }

  async manualSyncTrends(userId: string): Promise<void> {
    const movies = await this.movieRepo.find({ where: { userId } });
    if (movies.length === 0) return;

    const keywords = movies.map((m) => m.chineseName);
    const results = await this.trendsService.fetchTrends(keywords);

    for (let i = 0; i < movies.length; i++) {
      const movie = movies[i];
      const trendResult = results[i];
      if (trendResult) {
        await this.trendsService.saveTrends(movie.id, [trendResult], "VN");
        movie.trendScore = String(trendResult.trendScore);
        await this.movieRepo.save(movie);
      }
    }
  }

  private async syncChannelData(channel: YouTubeChannel, accessToken: string): Promise<void> {
    const info = await this.youtubeApi.getChannelInfo(accessToken, channel.channelId);
    if (!info) return;

    channel.name = info.title;
    channel.thumbnail = info.thumbnail;
    channel.subscriberCount = info.subscriberCount;
    channel.videoCount = info.videoCount;
    channel.viewCount = String(info.viewCount);
    await this.channelRepo.save(channel);
  }

  private async syncVideos(channel: YouTubeChannel, accessToken: string): Promise<void> {
    const { videos } = await this.youtubeApi.getVideos(accessToken, channel.channelId, 50);

    for (const video of videos) {
      const existing = await this.videoRepo.findOne({ where: { videoId: video.id } });

      if (existing) {
        existing.title = video.title;
        existing.thumbnail = video.thumbnail;
        existing.views = String(video.viewCount);
        existing.likes = video.likeCount;
        existing.comments = video.commentCount;
        await this.videoRepo.save(existing);
      } else {
        const newVideo = this.videoRepo.create({
          videoId: video.id,
          title: video.title,
          thumbnail: video.thumbnail,
          description: video.description,
          publishedAt: video.publishedAt ? new Date(video.publishedAt) : null,
          views: String(video.viewCount),
          likes: video.likeCount,
          comments: video.commentCount,
          channelId: channel.id,
        });
        await this.videoRepo.save(newVideo);
      }
    }
  }

  private async syncAnalyticsSnapshots(channel: YouTubeChannel, accessToken: string): Promise<void> {
    const endDate = new Date().toISOString().split("T")[0];
    const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const dailyData = await this.youtubeApi.getChannelAnalytics(
      accessToken,
      channel.channelId,
      startDate,
      endDate,
    );

    for (const day of dailyData) {
      const existing = await this.snapshotRepo.findOne({
        where: { channelId: channel.id, date: day.date },
      });

      if (existing) {
        existing.views = String(day.views);
        existing.subscribersGained = day.subscribersGained;
        existing.subscribersLost = day.subscribersLost;
        existing.watchTimeHours = String((day.estimatedMinutesWatched / 60).toFixed(2));
        existing.ctr = String(day.ctr);
        existing.impressions = String(day.impressions);
        existing.avgViewDuration = day.averageViewDuration;
        existing.revenue = String(day.revenue);
        existing.likes = day.likes;
        existing.comments = day.comments;
        existing.shares = day.shares;
        await this.snapshotRepo.save(existing);
      } else {
        const snapshot = this.snapshotRepo.create({
          date: day.date,
          views: String(day.views),
          subscribers: channel.subscriberCount,
          subscribersGained: day.subscribersGained,
          subscribersLost: day.subscribersLost,
          watchTimeHours: String((day.estimatedMinutesWatched / 60).toFixed(2)),
          ctr: String(day.ctr),
          impressions: String(day.impressions),
          avgViewDuration: day.averageViewDuration,
          revenue: String(day.revenue),
          likes: day.likes,
          comments: day.comments,
          shares: day.shares,
          channelId: channel.id,
        });
        await this.snapshotRepo.save(snapshot);
      }
    }
  }
}
