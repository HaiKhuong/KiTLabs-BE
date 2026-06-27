import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { AnalyticsSnapshot } from "../entities/analytics-snapshot.entity";
import { YouTubeChannel } from "../entities/youtube-channel.entity";
import { YouTubeVideo } from "../entities/youtube-video.entity";
import { AnalyticsQueryDto } from "../dto/analytics.dto";

@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(AnalyticsSnapshot, "tool")
    private readonly snapshotRepo: Repository<AnalyticsSnapshot>,
    @InjectRepository(YouTubeChannel, "tool")
    private readonly channelRepo: Repository<YouTubeChannel>,
    @InjectRepository(YouTubeVideo, "tool")
    private readonly videoRepo: Repository<YouTubeVideo>,
  ) {}

  async getChannelAnalytics(userId: string, query: AnalyticsQueryDto) {
    const channel = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (!channel) return { snapshots: [], summary: null };

    const startDate = query.startDate ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const endDate = query.endDate ?? new Date().toISOString().split("T")[0];

    const snapshots = await this.snapshotRepo
      .createQueryBuilder("s")
      .where("s.channel_id = :channelId", { channelId: channel.id })
      .andWhere("s.date >= :startDate", { startDate })
      .andWhere("s.date <= :endDate", { endDate })
      .orderBy("s.date", "ASC")
      .getMany();

    const summary = this.calculateSummary(snapshots);

    return { snapshots, summary };
  }

  async getVideoAnalytics(userId: string) {
    const channel = await this.channelRepo.findOne({ where: { userId, isActive: true } });
    if (!channel) return [];

    return this.videoRepo.find({
      where: { channelId: channel.id },
      order: { views: "DESC" },
    });
  }

  async exportCsv(userId: string, query: AnalyticsQueryDto): Promise<string> {
    const { snapshots } = await this.getChannelAnalytics(userId, query);

    const headers = [
      "Date",
      "Views",
      "Subscribers",
      "Subscribers Gained",
      "Subscribers Lost",
      "Watch Time (hrs)",
      "CTR (%)",
      "Impressions",
      "Avg View Duration (s)",
      "Revenue",
      "Likes",
      "Comments",
      "Shares",
    ];

    const rows = snapshots.map((s) =>
      [
        s.date,
        s.views,
        s.subscribers,
        s.subscribersGained,
        s.subscribersLost,
        s.watchTimeHours,
        s.ctr,
        s.impressions,
        s.avgViewDuration,
        s.revenue,
        s.likes,
        s.comments,
        s.shares,
      ].join(","),
    );

    return [headers.join(","), ...rows].join("\n");
  }

  private calculateSummary(snapshots: AnalyticsSnapshot[]) {
    if (snapshots.length === 0) return null;

    const totalViews = snapshots.reduce((sum, s) => sum + Number(s.views), 0);
    const avgCtr = snapshots.reduce((sum, s) => sum + Number(s.ctr), 0) / snapshots.length;
    const totalWatchTime = snapshots.reduce((sum, s) => sum + Number(s.watchTimeHours), 0);
    const totalRevenue = snapshots.reduce((sum, s) => sum + Number(s.revenue), 0);
    const totalSubsGained = snapshots.reduce((sum, s) => sum + s.subscribersGained, 0);
    const totalSubsLost = snapshots.reduce((sum, s) => sum + s.subscribersLost, 0);

    return {
      totalViews,
      avgCtr: Number(avgCtr.toFixed(2)),
      totalWatchTimeHours: Number(totalWatchTime.toFixed(2)),
      totalRevenue: Number(totalRevenue.toFixed(2)),
      netSubscribers: totalSubsGained - totalSubsLost,
      daysTracked: snapshots.length,
    };
  }
}
