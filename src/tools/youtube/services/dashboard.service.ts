import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { YouTubeVideo } from "../entities/youtube-video.entity";
import { AnalyticsSnapshot } from "../entities/analytics-snapshot.entity";
import { Recommendation } from "../entities/recommendation.entity";
import { AiService } from "../ai/ai.service";

@Injectable()
export class YouTubeDashboardService {
  constructor(
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    @InjectRepository(YouTubeVideo, "tool")
    private readonly videoRepo: Repository<YouTubeVideo>,
    @InjectRepository(AnalyticsSnapshot, "tool")
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(Recommendation, "tool")
    private readonly recRepo: Repository<Recommendation>,
  ) {}

  async getDashboardData(userId: string) {
    const channels = await this.channelRepo.find({ where: { userId } });
    let channel = channels.find((c) => c.isActive) ?? null;

    if (!channel && channels.length > 0) {
      channel = channels[0];
      await this.channelRepo.update({ userId }, { isActive: false });
      channel.isActive = true;
      await this.channelRepo.save(channel);
    }

    if (!channel) {
      return { connected: false, overview: null, topVideos: [], recommendations: [], summary: null };
    }

    const [overview, topVideos, recommendations, recentSnapshots] = await Promise.all([
      this.getOverview(channel),
      this.getTopVideos(channel.id),
      this.recRepo.find({
        where: { userId, isActive: true },
        relations: ["movie"],
        order: { score: "DESC" },
        take: 5,
      }),
      this.getRecentSnapshots(channel.id, 7),
    ]);

    const summary = this.generateSummary(recentSnapshots, overview);

    return {
      connected: true,
      overview,
      topVideos,
      recommendations,
      summary,
    };
  }

  async getChartData(userId: string, startDate?: string, endDate?: string) {
    const channel = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (!channel) return { snapshots: [] };

    const start = startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const end = endDate ?? new Date().toISOString().split("T")[0];

    const snapshots = await this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.channel_id = :channelId", { channelId: channel.id })
      .andWhere("s.date >= :start", { start })
      .andWhere("s.date <= :end", { end })
      .orderBy("s.date", "ASC")
      .getMany();

    return { snapshots };
  }

  private async getOverview(channel: YouTubeChannel) {
    const recentSnapshots = await this.getRecentSnapshots(channel.id, 7);

    const totalViews = recentSnapshots.reduce((sum, s) => sum + Number(s.views), 0);
    const avgCtr = recentSnapshots.length > 0
      ? recentSnapshots.reduce((sum, s) => sum + Number(s.ctr), 0) / recentSnapshots.length
      : 0;
    const totalWatchTime = recentSnapshots.reduce((sum, s) => sum + Number(s.watchTimeHours), 0);
    const totalImpressions = recentSnapshots.reduce((sum, s) => sum + Number(s.impressions), 0);
    const totalRevenue = recentSnapshots.reduce((sum, s) => sum + Number(s.revenue), 0);

    return {
      channel: {
        name: channel.name,
        thumbnail: channel.thumbnail,
        subscriberCount: channel.subscriberCount,
        totalViews: channel.viewCount,
      },
      last7Days: {
        views: totalViews,
        ctr: Number(avgCtr.toFixed(2)),
        watchTimeHours: Number(totalWatchTime.toFixed(2)),
        impressions: totalImpressions,
        revenue: Number(totalRevenue.toFixed(2)),
        subscribersGained: recentSnapshots.reduce((sum, s) => sum + s.subscribersGained, 0),
      },
    };
  }

  private async getTopVideos(channelId: string) {
    return this.videoRepo.find({
      where: { channelId },
      order: { views: "DESC" },
      take: 10,
    });
  }

  private async getRecentSnapshots(channelId: string, days: number): Promise<AnalyticsSnapshot[]> {
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    return this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.channel_id = :channelId", { channelId })
      .andWhere("s.date >= :startDate", { startDate })
      .orderBy("s.date", "ASC")
      .getMany();
  }

  private generateSummary(snapshots: AnalyticsSnapshot[], overview: any) {
    if (snapshots.length < 2) return null;

    const insights: string[] = [];
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];

    const viewsTrend = Number(last.views) - Number(first.views);
    if (viewsTrend > 0) {
      insights.push(`Views tăng ${viewsTrend.toLocaleString()} trong 7 ngày qua`);
    } else if (viewsTrend < 0) {
      insights.push(`Views giảm ${Math.abs(viewsTrend).toLocaleString()} trong 7 ngày qua`);
    }

    const ctrDiff = Number(last.ctr) - Number(first.ctr);
    if (Math.abs(ctrDiff) > 0.1) {
      insights.push(`CTR ${ctrDiff > 0 ? "tăng" : "giảm"} ${Math.abs(ctrDiff).toFixed(2)}%`);
    }

    const subGained = snapshots.reduce((sum, s) => sum + s.subscribersGained, 0);
    const subLost = snapshots.reduce((sum, s) => sum + s.subscribersLost, 0);
    const netSubs = subGained - subLost;
    insights.push(`Subscribers: +${subGained} / -${subLost} (net: ${netSubs >= 0 ? "+" : ""}${netSubs})`);

    return { insights, period: "7 days" };
  }
}
