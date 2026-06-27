import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { v4 as uuidv4 } from "uuid";

import { Recommendation, RecommendationPriority } from "../entities/recommendation.entity";
import { Movie } from "../entities/movie.entity";
import { YouTubeVideo } from "../entities/youtube-video.entity";
import { AnalyticsSnapshot } from "../entities/analytics-snapshot.entity";
import { MovieTrend } from "../entities/movie-trend.entity";
import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { AiService } from "../ai/ai.service";
import { AiAnalysisInput } from "../ai/ai-provider.interface";

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(
    @InjectRepository(Recommendation, "tool")
    private readonly recRepo: Repository<Recommendation>,
    @InjectRepository(Movie, "tool")
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(YouTubeVideo, "tool")
    private readonly videoRepo: Repository<YouTubeVideo>,
    @InjectRepository(AnalyticsSnapshot, "tool")
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(MovieTrend, "tool")
    private readonly trendRepo: Repository<MovieTrend>,
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    private readonly aiService: AiService,
  ) {}

  async generateRecommendations(userId: string): Promise<Recommendation[]> {
    const channel = await this.channelRepo.findOne({
      where: { userId, isActive: true },
    });

    if (!channel) {
      this.logger.warn(`No active channel for user ${userId}`);
      return [];
    }

    const input = await this.buildAnalysisInput(channel, userId);
    const aiResult = await this.aiService.analyze(input);

    // Deactivate old recommendations
    await this.recRepo.update({ userId, isActive: true }, { isActive: false });

    const batchId = uuidv4().substring(0, 8);
    const recommendations: Recommendation[] = [];

    for (const rec of aiResult.recommendations) {
      const movie = await this.movieRepo.findOne({
        where: { chineseName: rec.movie, userId },
      });

      if (!movie) continue;

      // Update movie score
      movie.score = String(rec.score);
      await this.movieRepo.save(movie);

      const priority = this.mapPriority(rec.priority);
      const recommendation = this.recRepo.create({
        score: String(rec.score),
        priority,
        reason: rec.reason,
        risk: rec.risk,
        expectedViews: rec.expectedViews,
        expectedCtr: rec.expectedCtr,
        generatedAt: new Date(),
        isActive: true,
        batchId,
        movieId: movie.id,
        userId,
      });

      recommendations.push(await this.recRepo.save(recommendation));
    }

    this.logger.log(`Generated ${recommendations.length} recommendations for user ${userId}`);
    return recommendations;
  }

  async getActiveRecommendations(userId: string): Promise<Recommendation[]> {
    return this.recRepo.find({
      where: { userId, isActive: true },
      relations: ["movie"],
      order: { score: "DESC" },
    });
  }

  async getRecommendationHistory(userId: string, limit = 50): Promise<Recommendation[]> {
    return this.recRepo.find({
      where: { userId },
      relations: ["movie"],
      order: { generatedAt: "DESC" },
      take: limit,
    });
  }

  private async buildAnalysisInput(channel: YouTubeChannel, userId: string): Promise<AiAnalysisInput> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const dateStr = thirtyDaysAgo.toISOString().split("T")[0];

    const [videos, snapshots, movies, trends] = await Promise.all([
      this.videoRepo.find({
        where: { channelId: channel.id },
        order: { views: "DESC" },
        take: 20,
      }),
      this.snapshotRepo
        .createQueryBuilder("s")
        .where("s.channel_id = :channelId", { channelId: channel.id })
        .andWhere("s.date >= :date", { date: dateStr })
        .orderBy("s.date", "ASC")
        .getMany(),
      this.movieRepo.find({
        where: { userId },
      }),
      this.trendRepo
        .createQueryBuilder("t")
        .leftJoinAndSelect("t.movie", "movie")
        .where("movie.user_id = :userId", { userId })
        .andWhere("t.date >= :date", { date: dateStr })
        .orderBy("t.date", "DESC")
        .getMany(),
    ]);

    return {
      channel: {
        name: channel.name,
        subscriberCount: channel.subscriberCount,
        videoCount: channel.videoCount,
        viewCount: channel.viewCount,
      },
      videos: videos.map((v) => ({
        title: v.title,
        views: v.views,
        ctr: v.ctr,
        watchTimeHours: v.watchTimeHours,
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
      analytics: {
        recentDays: snapshots.map((s) => ({
          date: s.date,
          views: Number(s.views),
          subscribers: s.subscribers,
          ctr: s.ctr,
          watchTimeHours: s.watchTimeHours,
          impressions: s.impressions,
          revenue: s.revenue,
        })),
      },
      movies: movies.map((m) => ({
        chineseName: m.chineseName,
        vietnameseName: m.vietnameseName,
        status: m.status,
        score: m.score,
        trendScore: m.trendScore,
        tags: m.tags,
      })),
      googleTrends: trends.map((t) => ({
        keyword: t.keyword ?? "",
        trendScore: t.trendScore,
        searchVolume: t.searchVolume,
      })),
    };
  }

  private mapPriority(priority: string): RecommendationPriority {
    switch (priority.toLowerCase()) {
      case "high":
        return RecommendationPriority.HIGH;
      case "critical":
        return RecommendationPriority.CRITICAL;
      case "low":
        return RecommendationPriority.LOW;
      default:
        return RecommendationPriority.MEDIUM;
    }
  }
}
