import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { Between, DataSource, In } from "typeorm";
import {
  FilmReportDailyContent,
  FilmReportDailyExpLeaderboard,
  FilmReportDailyTraffic,
  FilmReportDailyUsers,
} from "../../entities/film-report.entities";
import {
  FilmAnalyticsScannerService,
  getVietnamDateKey,
} from "./film-analytics-scanner.service";

export interface DashboardFilterQuery {
  range?: "today" | "yesterday" | "7d" | "30d";
  date?: string;
}

@Injectable()
export class FilmAnalyticsAdminService {
  constructor(
    @InjectDataSource("film") private readonly filmDb: DataSource,
    private readonly scanner: FilmAnalyticsScannerService,
  ) {}

  /**
   * Returns aggregated dashboard metrics from the pre-computed reports_xxx tables
   */
  async getDashboardData(query: DashboardFilterQuery) {
    const range = query.range || "today";
    const todayKey = getVietnamDateKey();

    let targetDateKey = todayKey;
    if (query.date) {
      targetDateKey = query.date;
    } else if (range === "yesterday") {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      targetDateKey = getVietnamDateKey(yesterday);
    }

    const trafficRepo = this.filmDb.getRepository(FilmReportDailyTraffic);
    const userRepo = this.filmDb.getRepository(FilmReportDailyUsers);
    const leaderboardRepo = this.filmDb.getRepository(FilmReportDailyExpLeaderboard);
    const contentRepo = this.filmDb.getRepository(FilmReportDailyContent);

    // If multi-day range (7d or 30d)
    if (range === "7d" || range === "30d") {
      const daysCount = range === "7d" ? 7 : 30;
      const dateKeys: string[] = [];
      for (let i = daysCount - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        dateKeys.push(getVietnamDateKey(d));
      }

      const trafficReports = await trafficRepo.find({
        where: { dateKey: In(dateKeys) },
        order: { dateKey: "ASC" },
      });

      const userReports = await userRepo.find({
        where: { dateKey: In(dateKeys) },
        order: { dateKey: "ASC" },
      });

      const todayLeaderboard = await leaderboardRepo.find({
        where: { dateKey: todayKey },
        order: { rank: "ASC" },
        take: 5,
      });

      const latestContent = await contentRepo.findOne({
        where: { dateKey: todayKey },
      });

      // Combine traffic by day
      let totalViews = 0;
      let totalSessions = 0;
      let actionSessions = 0;
      let totalNewUsers = 0;
      const actionsBreakdown: Record<string, number> = {};

      const timeline = dateKeys.map((dk) => {
        const tr = trafficReports.find((t) => t.dateKey === dk);
        const ur = userReports.find((u) => u.dateKey === dk);

        const views = tr ? tr.totalPageViews : 0;
        const sessions = tr ? tr.totalSessions : 0;
        const actSessions = tr ? tr.actionSessions : 0;
        const newUsers = ur ? ur.newUsersCount : 0;

        totalViews += views;
        totalSessions += sessions;
        actionSessions += actSessions;
        totalNewUsers += newUsers;

        if (tr?.actionsBreakdown) {
          for (const [k, v] of Object.entries(tr.actionsBreakdown)) {
            actionsBreakdown[k] = (actionsBreakdown[k] || 0) + Number(v);
          }
        }

        return {
          label: dk.substring(5), // 'MM-DD'
          dateKey: dk,
          views,
          sessions,
          actionSessions,
          newUsers,
        };
      });

      const actionRate = totalSessions > 0 ? Number(((actionSessions / totalSessions) * 100).toFixed(2)) : 0;

      return {
        summary: {
          totalPageViews: totalViews,
          totalSessions,
          actionSessions,
          actionRate,
          newUsersCount: totalNewUsers,
          totalUsers: userReports[userReports.length - 1]?.totalUsers || 0,
          pendingReports: latestContent?.pendingReports || 0,
          pendingComments: latestContent?.pendingComments || 0,
        },
        timeline,
        actionsBreakdown,
        topPages: trafficReports[trafficReports.length - 1]?.topPages || [],
        topExpUsers: todayLeaderboard || [],
        topMovies: latestContent?.topWatchedMovies || [],
        meta: {
          range,
          dateKey: todayKey,
          lastScannedAt: trafficReports[trafficReports.length - 1]?.lastScannedAt || new Date(),
        },
      };
    }

    // Single day range (today / yesterday / specific date)
    let traffic = await trafficRepo.findOne({ where: { dateKey: targetDateKey } });
    let users = await userRepo.findOne({ where: { dateKey: targetDateKey } });
    let content = await contentRepo.findOne({ where: { dateKey: targetDateKey } });
    let leaderboard = await leaderboardRepo.find({
      where: { dateKey: targetDateKey },
      order: { rank: "ASC" },
      take: 5,
    });

    // If no report exists yet for today, trigger a quick initial sync
    if (!traffic && targetDateKey === todayKey) {
      await this.scanner.syncDate(todayKey);
      traffic = await trafficRepo.findOne({ where: { dateKey: targetDateKey } });
      users = await userRepo.findOne({ where: { dateKey: targetDateKey } });
      content = await contentRepo.findOne({ where: { dateKey: targetDateKey } });
      leaderboard = await leaderboardRepo.find({
        where: { dateKey: targetDateKey },
        order: { rank: "ASC" },
        take: 5,
      });
    }

    // Yesterday comparison for growth %
    const yesterdayDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayKey = getVietnamDateKey(yesterdayDate);
    const yesterdayTraffic = await trafficRepo.findOne({ where: { dateKey: yesterdayKey } });
    const yesterdayUsers = await userRepo.findOne({ where: { dateKey: yesterdayKey } });

    const totalViews = traffic?.totalPageViews || 0;
    const prevViews = yesterdayTraffic?.totalPageViews || 0;
    const viewsDiffPercent =
      prevViews > 0 ? Number((((totalViews - prevViews) / prevViews) * 100).toFixed(1)) : 0;

    const newUsers = users?.newUsersCount || 0;
    const prevNewUsers = yesterdayUsers?.newUsersCount || 0;
    const usersDiffPercent =
      prevNewUsers > 0 ? Number((((newUsers - prevNewUsers) / prevNewUsers) * 100).toFixed(1)) : 0;

    // Hourly timeline (0..23h)
    const hourlyTimeline = (traffic?.hourlyStats || []).map((h) => ({
      label: `${String(h.hour).padStart(2, "0")}:00`,
      hour: h.hour,
      views: h.views,
      actionSessions: h.actionSessions,
    }));

    return {
      summary: {
        totalPageViews: totalViews,
        viewsDiffPercent,
        totalSessions: traffic?.totalSessions || 0,
        actionSessions: traffic?.actionSessions || 0,
        actionRate: Number(traffic?.actionRate || 0),
        newUsersCount: newUsers,
        usersDiffPercent,
        totalUsers: users?.totalUsers || 0,
        pendingReports: content?.pendingReports || 0,
        pendingComments: content?.pendingComments || 0,
      },
      timeline: hourlyTimeline,
      actionsBreakdown: traffic?.actionsBreakdown || {},
      topPages: traffic?.topPages || [],
      topExpUsers: leaderboard || [],
      topMovies: content?.topWatchedMovies || [],
      meta: {
        range,
        dateKey: targetDateKey,
        lastScannedAt: traffic?.lastScannedAt || new Date(),
      },
    };
  }

  /**
   * Manually triggers scanner for a specific date or today
   */
  async triggerManualSync(dateKey?: string) {
    return this.scanner.syncDate(dateKey);
  }
}

