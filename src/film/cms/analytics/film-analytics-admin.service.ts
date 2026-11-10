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

      let trafficReports = await trafficRepo.find({
        where: { dateKey: In(dateKeys) },
        order: { dateKey: "ASC" },
      });

      // If any dateKeys are not yet in reports_daily_traffic, backfill them
      const scannedKeys = new Set(trafficReports.map((t) => t.dateKey));
      const missingKeys = dateKeys.filter((dk) => !scannedKeys.has(dk));
      if (missingKeys.length > 0) {
        for (const mk of missingKeys) {
          await this.scanner.syncDate(mk);
        }
        trafficReports = await trafficRepo.find({
          where: { dateKey: In(dateKeys) },
          order: { dateKey: "ASC" },
        });
      }

      const userReports = await userRepo.find({
        where: { dateKey: In(dateKeys) },
        order: { dateKey: "ASC" },
      });

      const contentReports = await contentRepo.find({
        where: { dateKey: In(dateKeys) },
      });

      const leaderboardReports = await leaderboardRepo.find({
        where: { dateKey: In(dateKeys) },
      });

      const latestContent = contentReports.find((c) => c.dateKey === todayKey) || contentReports[contentReports.length - 1];

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

      // Aggregate topPages across the range
      const pageMap = new Map<string, number>();
      for (const tr of trafficReports) {
        for (const p of tr.topPages || []) {
          pageMap.set(p.path, (pageMap.get(p.path) || 0) + Number(p.views || 0));
        }
      }
      const topPages = Array.from(pageMap.entries())
        .map(([path, views]) => ({ path, views }))
        .sort((a, b) => b.views - a.views)
        .slice(0, 10);

      // Aggregate topSearches across the range
      const searchMap = new Map<string, number>();
      for (const tr of trafficReports) {
        for (const s of tr.topSearches || []) {
          searchMap.set(s.keyword, (searchMap.get(s.keyword) || 0) + Number(s.count || 0));
        }
      }
      const topSearches = Array.from(searchMap.entries())
        .map(([keyword, count]) => ({ keyword, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      // Aggregate topMovies across the range
      const movieMap = new Map<string, any>();
      for (const cr of contentReports) {
        for (const m of cr.topWatchedMovies || []) {
          const existing = movieMap.get(m.movieId);
          if (existing) {
            existing.views += Number(m.views || 0);
            if (!existing.bannerUrl && m.bannerUrl) existing.bannerUrl = m.bannerUrl;
            if (!existing.slug && m.slug) existing.slug = m.slug;
          } else {
            movieMap.set(m.movieId, { ...m, views: Number(m.views || 0) });
          }
        }
      }
      const topMovies = Array.from(movieMap.values())
        .sort((a, b) => b.views - a.views)
        .slice(0, 10);

      // Aggregate topExpUsers across the range
      const expMap = new Map<string, any>();
      for (const row of leaderboardReports) {
        const existing = expMap.get(row.userId);
        if (existing) {
          existing.totalExpToday += Number(row.totalExpToday || 0);
          existing.txCount += Number(row.txCount || 0);
          if (new Date(row.earliestAt) < new Date(existing.earliestAt)) {
            existing.earliestAt = row.earliestAt;
          }
        } else {
          expMap.set(row.userId, { ...row, totalExpToday: Number(row.totalExpToday || 0) });
        }
      }
      const topExpUsers = Array.from(expMap.values())
        .sort((a, b) => b.totalExpToday - a.totalExpToday)
        .slice(0, 5)
        .map((u, idx) => ({ ...u, rank: idx + 1 }));

      const actionRate = totalSessions > 0 ? Number(((actionSessions / totalSessions) * 100).toFixed(2)) : 0;

      // Latest or cumulative topFavoritedMovies
      const topFavoritedMovies = latestContent?.topFavoritedMovies || [];

      // Aggregate topCommenters across range
      const commenterMap = new Map<string, any>();
      for (const cr of contentReports) {
        for (const u of cr.topCommenters || []) {
          const existing = commenterMap.get(u.userId);
          if (existing) {
            existing.commentCount += Number(u.commentCount || 0);
          } else {
            commenterMap.set(u.userId, { ...u, commentCount: Number(u.commentCount || 0) });
          }
        }
      }
      const topCommenters = Array.from(commenterMap.values())
        .sort((a, b) => b.commentCount - a.commentCount)
        .slice(0, 5)
        .map((u, idx) => ({ ...u, rank: idx + 1 }));

      // Aggregate topSharers across range
      const sharerMap = new Map<string, any>();
      for (const cr of contentReports) {
        for (const u of cr.topSharers || []) {
          const existing = sharerMap.get(u.userId);
          if (existing) {
            existing.shareCount += Number(u.shareCount || 0);
          } else {
            sharerMap.set(u.userId, { ...u, shareCount: Number(u.shareCount || 0) });
          }
        }
      }
      const topSharers = Array.from(sharerMap.values())
        .sort((a, b) => b.shareCount - a.shareCount)
        .slice(0, 5)
        .map((u, idx) => ({ ...u, rank: idx + 1 }));

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
        topPages,
        topSearches,
        topExpUsers,
        topMovies,
        topFavoritedMovies,
        topCommenters,
        topSharers,
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

    // If no report exists yet for targetDateKey, or if today's report is stale (> 5 mins), trigger sync
    const isTodayStale =
      targetDateKey === todayKey &&
      (!traffic || (traffic.lastScannedAt && Date.now() - new Date(traffic.lastScannedAt).getTime() > 5 * 60 * 1000));
    const isMissingTarget = !traffic;

    if (isMissingTarget || isTodayStale) {
      await this.scanner.syncDate(targetDateKey);
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
      topSearches: traffic?.topSearches || [],
      topExpUsers: leaderboard || [],
      topMovies: content?.topWatchedMovies || [],
      topFavoritedMovies: content?.topFavoritedMovies || [],
      topCommenters: content?.topCommenters || [],
      topSharers: content?.topSharers || [],
      meta: {
        range,
        dateKey: targetDateKey,
        lastScannedAt: traffic?.lastScannedAt || new Date(),
      },
    };
  }

  /**
   * Manually triggers scanner for a specific date or today or range
   */
  async triggerManualSync(dateKey?: string, range?: string) {
    if (range === "yesterday") {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      return this.scanner.syncDate(getVietnamDateKey(yesterday));
    }
    if (range === "7d" || range === "30d") {
      const daysCount = range === "7d" ? 7 : 30;
      for (let i = daysCount - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
        await this.scanner.syncDate(getVietnamDateKey(d));
      }
      return this.scanner.syncDate();
    }
    return this.scanner.syncDate(dateKey);
  }
}

