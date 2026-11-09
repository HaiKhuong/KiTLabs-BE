import { Injectable, Logger, OnApplicationBootstrap, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import {
  FilmReportDailyContent,
  FilmReportDailyExpLeaderboard,
  FilmReportDailyTraffic,
  FilmReportDailyUsers,
} from "../../entities/film-report.entities";

export function getVietnamDateKey(d: Date = new Date()): string {
  // Convert UTC date to Vietnam GMT+7 format YYYY-MM-DD
  const vnTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
  return vnTime.toISOString().split("T")[0];
}

export function getDateKeyRange(dateKey: string): { start: Date; end: Date } {
  // Return UTC start and end bounds corresponding to full Vietnam day (00:00:00 to 23:59:59.999 GMT+7)
  const [year, month, day] = dateKey.split("-").map(Number);
  // GMT+7 00:00 is (day - 1) 17:00 UTC
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - 7 * 60 * 60 * 1000);
  const end = new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999) - 7 * 60 * 60 * 1000);
  return { start, end };
}

@Injectable()
export class FilmAnalyticsScannerService implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(FilmAnalyticsScannerService.name);
  private isScanning = false;

  constructor(
    @InjectDataSource("film") private readonly filmDb: DataSource,
    @InjectDataSource("audit") private readonly auditDb: DataSource,
  ) {}

  async onModuleInit() {
    try {
      // Auto-verify that reports_xxx tables exist in film database
      await this.filmDb.query(`
        CREATE TABLE IF NOT EXISTS "reports_daily_traffic" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "date_key" character varying(10) NOT NULL,
          "total_page_views" integer NOT NULL DEFAULT 0,
          "total_sessions" integer NOT NULL DEFAULT 0,
          "action_sessions" integer NOT NULL DEFAULT 0,
          "action_rate" numeric(5,2) NOT NULL DEFAULT 0,
          "hourly_stats" jsonb NOT NULL DEFAULT '[]',
          "actions_breakdown" jsonb NOT NULL DEFAULT '{}',
          "top_pages" jsonb NOT NULL DEFAULT '[]',
          "top_searches" jsonb NOT NULL DEFAULT '[]',
          "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_reports_daily_traffic_id" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_traffic_date_key" ON "reports_daily_traffic" ("date_key");
        ALTER TABLE "reports_daily_traffic" ADD COLUMN IF NOT EXISTS "top_searches" jsonb NOT NULL DEFAULT '[]';

        CREATE TABLE IF NOT EXISTS "reports_daily_users" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "date_key" character varying(10) NOT NULL,
          "new_users_count" integer NOT NULL DEFAULT 0,
          "hourly_new_users" jsonb NOT NULL DEFAULT '[]',
          "total_users" integer NOT NULL DEFAULT 0,
          "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_reports_daily_users_id" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_users_date_key" ON "reports_daily_users" ("date_key");

        CREATE TABLE IF NOT EXISTS "reports_daily_exp_leaderboard" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "date_key" character varying(10) NOT NULL,
          "rank" integer NOT NULL,
          "user_id" uuid NOT NULL,
          "user_name" character varying(150) NOT NULL,
          "username" character varying(100),
          "avatar_url" text,
          "sect_rank" character varying(50) NOT NULL DEFAULT 'LUYEN_KHI',
          "current_title" character varying(150),
          "total_exp_today" integer NOT NULL DEFAULT 0,
          "earliest_at" TIMESTAMP WITH TIME ZONE NOT NULL,
          "latest_at" TIMESTAMP WITH TIME ZONE NOT NULL,
          "tx_count" integer NOT NULL DEFAULT 1,
          "exp_sources" jsonb,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_reports_daily_exp_leaderboard_id" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_exp_leaderboard_date_rank" ON "reports_daily_exp_leaderboard" ("date_key", "rank");
        CREATE INDEX IF NOT EXISTS "IDX_reports_daily_exp_leaderboard_user_id" ON "reports_daily_exp_leaderboard" ("user_id");

        CREATE TABLE IF NOT EXISTS "reports_daily_content" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "date_key" character varying(10) NOT NULL,
          "top_watched_movies" jsonb NOT NULL DEFAULT '[]',
          "pending_reports" integer NOT NULL DEFAULT 0,
          "pending_comments" integer NOT NULL DEFAULT 0,
          "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_reports_daily_content_id" PRIMARY KEY ("id")
        );
        CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_content_date_key" ON "reports_daily_content" ("date_key");
      `);
      this.logger.log("Reports tables (reports_xxx) verified successfully in film database.");
    } catch (err) {
      this.logger.warn(`Could not verify reports_xxx tables: ${(err as Error).message}`);
    }
  }

  async onApplicationBootstrap() {
    // Initial scan and backfill for the last 7 days so reports have complete data immediately
    setTimeout(() => {
      this.backfillDays(7).catch((err) =>
        this.logger.error(`Initial analytics scan and backfill failed: ${err.message}`, err.stack),
      );
    }, 3000);
  }

  /**
   * Backfills reports for the past N days sequentially
   */
  async backfillDays(daysCount = 7): Promise<void> {
    this.logger.log(`Starting analytics backfill for the past ${daysCount} days...`);
    for (let i = daysCount - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const dk = getVietnamDateKey(d);
      await this.syncDate(dk);
    }
    this.logger.log(`Analytics backfill for the past ${daysCount} days completed.`);
  }

  /**
   * Background Cron Job running every 10 minutes to scan raw events and update reports tables
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleCronScan() {
    this.logger.log("Running scheduled analytics scanner (every 10 minutes)...");
    try {
      await this.syncDate();
    } catch (err) {
      this.logger.error(`Scheduled analytics scanner error: ${(err as Error).message}`, (err as Error).stack);
    }
  }

  /**
   * Scans raw databases and upserts aggregated metrics into reports_xxx tables
   */
  async syncDate(targetDateKey?: string): Promise<{ success: boolean; dateKey: string; durationMs: number }> {
    if (this.isScanning) {
      this.logger.warn("Another analytics scan job is currently in progress. Skipping.");
      return { success: false, dateKey: targetDateKey || getVietnamDateKey(), durationMs: 0 };
    }

    const t0 = Date.now();
    this.isScanning = true;
    const dateKey = targetDateKey || getVietnamDateKey();
    const { start, end } = getDateKeyRange(dateKey);

    try {
      this.logger.log(`Scanning analytics data for [${dateKey}] (${start.toISOString()} to ${end.toISOString()})...`);

      // ==========================================
      // 1. SCAN AUDIT_LOGS (Traffic & Actions)
      // ==========================================
      let totalPageViews = 0;
      let totalSessions = 0;
      let actionSessions = 0;
      let actionRate = 0;
      let hourlyStats: Array<{ hour: number; views: number; actionSessions: number }> = [];
      let actionsBreakdown: Record<string, number> = {};
      let topPages: Array<{ path: string; views: number }> = [];
      let topSearches: Array<{ keyword: string; count: number }> = [];
      let topWatchedMovies: Array<{ movieId: string; title: string; slug?: string; bannerUrl?: string | null; views: number }> = [];

      try {
        // A. Total views & Session Conversion
        const sessionStatsQuery = `
          WITH page_sessions AS (
            SELECT DISTINCT session_id
            FROM audit_logs
            WHERE module = 'film' AND event = 'load_page' AND created_at >= $1 AND created_at <= $2
          ),
          action_sessions AS (
            SELECT DISTINCT session_id
            FROM audit_logs
            WHERE module = 'film' AND event != 'load_page' AND created_at >= $1 AND created_at <= $2
          )
          SELECT 
            (SELECT count(*)::int FROM audit_logs WHERE module = 'film' AND event = 'load_page' AND created_at >= $1 AND created_at <= $2) AS "totalPageViews",
            (SELECT count(*)::int FROM page_sessions) AS "totalSessions",
            (SELECT count(*)::int FROM page_sessions ps JOIN action_sessions a ON ps.session_id = a.session_id) AS "actionSessions";
        `;
        const sessionStatsRes = await this.auditDb.query(sessionStatsQuery, [start, end]);
        if (sessionStatsRes?.length) {
          totalPageViews = Number(sessionStatsRes[0].totalPageViews || 0);
          totalSessions = Number(sessionStatsRes[0].totalSessions || 0);
          actionSessions = Number(sessionStatsRes[0].actionSessions || 0);
          actionRate = totalSessions > 0 ? Number(((actionSessions / totalSessions) * 100).toFixed(2)) : 0;
        }

        // B. Hourly Breakdown (0 - 23h GMT+7)
        const hourlyQuery = `
          SELECT 
            EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,
            COUNT(CASE WHEN event = 'load_page' THEN 1 END)::int AS views,
            COUNT(DISTINCT CASE WHEN event != 'load_page' THEN session_id END)::int AS "actionSessions"
          FROM audit_logs
          WHERE module = 'film' AND created_at >= $1 AND created_at <= $2
          GROUP BY hour
          ORDER BY hour ASC;
        `;
        const hourlyRes = await this.auditDb.query(hourlyQuery, [start, end]);
        const hourMap = new Map<number, { views: number; actionSessions: number }>();
        for (let h = 0; h < 24; h++) hourMap.set(h, { views: 0, actionSessions: 0 });
        for (const r of hourlyRes || []) {
          hourMap.set(Number(r.hour), {
            views: Number(r.views || 0),
            actionSessions: Number(r.actionSessions || 0),
          });
        }
        hourlyStats = Array.from(hourMap.entries()).map(([hour, val]) => ({
          hour,
          views: val.views,
          actionSessions: val.actionSessions,
        }));

        // C. Actions Breakdown
        const actionsQuery = `
          SELECT event, COUNT(*)::int AS count
          FROM audit_logs
          WHERE module = 'film' AND event != 'load_page' AND created_at >= $1 AND created_at <= $2
          GROUP BY event
          ORDER BY count DESC;
        `;
        const actionsRes = await this.auditDb.query(actionsQuery, [start, end]);
        for (const row of actionsRes || []) {
          actionsBreakdown[row.event] = Number(row.count || 0);
        }

        // D. Top Viewed Pages
        const topPagesQuery = `
          SELECT COALESCE(page, object_id, '/') AS path, COUNT(*)::int AS views
          FROM audit_logs
          WHERE module = 'film' AND event = 'load_page' AND created_at >= $1 AND created_at <= $2
          GROUP BY path
          ORDER BY views DESC
          LIMIT 10;
        `;
        const topPagesRes = await this.auditDb.query(topPagesQuery, [start, end]);
        topPages = (topPagesRes || []).map((r: any) => ({
          path: String(r.path || "/"),
          views: Number(r.views || 0),
        }));

        // E. Top Search Keywords
        const topSearchesQuery = `
          SELECT 
            COALESCE(object_name, object_id, metadata->>'query') AS keyword,
            COUNT(*)::int AS count
          FROM audit_logs
          WHERE module = 'film' AND event = 'search' AND created_at >= $1 AND created_at <= $2
            AND COALESCE(object_name, object_id, metadata->>'query') IS NOT NULL
            AND TRIM(COALESCE(object_name, object_id, metadata->>'query')) != ''
          GROUP BY keyword
          ORDER BY count DESC
          LIMIT 10;
        `;
        const topSearchesRes = await this.auditDb.query(topSearchesQuery, [start, end]);
        topSearches = (topSearchesRes || []).map((r: any) => ({
          keyword: String(r.keyword || "").trim(),
          count: Number(r.count || 0),
        }));

        // F. Top Watched Movies (from play_movie merged with real movie metadata)
        const topMoviesQuery = `
          SELECT 
            object_id AS "movieId",
            COALESCE(object_name, 'Phim chưa đặt tên') AS title,
            COUNT(*)::int AS views
          FROM audit_logs
          WHERE module = 'film' AND event = 'play_movie' AND created_at >= $1 AND created_at <= $2
          GROUP BY object_id, object_name
          ORDER BY views DESC
          LIMIT 10;
        `;
        const topMoviesRes = await this.auditDb.query(topMoviesQuery, [start, end]);

        if (topMoviesRes?.length) {
          const rawIds = topMoviesRes
            .map((r: any) => String(r.movieId || ""))
            .filter((id: string) => id && id.length > 5);

          let moviesInfo: any[] = [];
          if (rawIds.length > 0) {
            try {
              moviesInfo = await this.filmDb.query(
                `SELECT id, title, slug, banner_url AS "bannerUrl", thumbnail_url AS "thumbnailUrl" 
                 FROM movies 
                 WHERE id::text = ANY($1::text[])`,
                [rawIds],
              );
            } catch (movieErr) {
              this.logger.warn(`Could not join movies table: ${(movieErr as Error).message}`);
            }
          }

          const movieMap = new Map<string, any>();
          for (const m of moviesInfo || []) {
            movieMap.set(String(m.id), m);
          }

          topWatchedMovies = topMoviesRes.map((r: any) => {
            const m = movieMap.get(String(r.movieId));
            return {
              movieId: String(r.movieId || ""),
              title: m?.title || String(r.title || "Phim chưa đặt tên"),
              slug: m?.slug || "",
              bannerUrl: m?.bannerUrl || m?.thumbnailUrl || null,
              views: Number(r.views || 0),
            };
          });
        }
      } catch (auditErr) {
        this.logger.error(`Failed to scan audit_logs: ${(auditErr as Error).message}`);
      }

      // ==========================================
      // 2. SCAN FILM DB (Users & EXP Leaderboard)
      // ==========================================
      let newUsersCount = 0;
      let hourlyNewUsers: Array<{ hour: number; count: number }> = [];
      let totalUsers = 0;
      let leaderboard: any[] = [];
      let pendingReports = 0;
      let pendingComments = 0;

      try {
        // A. New Users Today
        const userStatsQuery = `
          SELECT 
            COUNT(CASE WHEN created_at >= $1 AND created_at <= $2 THEN 1 END)::int AS "newUsersCount",
            COUNT(*)::int AS "totalUsers"
          FROM users
          WHERE deleted_at IS NULL;
        `;
        const userStatsRes = await this.filmDb.query(userStatsQuery, [start, end]);
        if (userStatsRes?.length) {
          newUsersCount = Number(userStatsRes[0].newUsersCount || 0);
          totalUsers = Number(userStatsRes[0].totalUsers || 0);
        }

        // B. Hourly New Users
        const hourlyUsersQuery = `
          SELECT 
            EXTRACT(HOUR FROM created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Ho_Chi_Minh')::int AS hour,
            COUNT(*)::int AS count
          FROM users
          WHERE created_at >= $1 AND created_at <= $2 AND deleted_at IS NULL
          GROUP BY hour
          ORDER BY hour ASC;
        `;
        const hourlyUsersRes = await this.filmDb.query(hourlyUsersQuery, [start, end]);
        const userHourMap = new Map<number, number>();
        for (let h = 0; h < 24; h++) userHourMap.set(h, 0);
        for (const r of hourlyUsersRes || []) {
          userHourMap.set(Number(r.hour), Number(r.count || 0));
        }
        hourlyNewUsers = Array.from(userHourMap.entries()).map(([hour, count]) => ({ hour, count }));

        // C. Top 10 EXP Earners (Highest EXP & Earliest Timestamp)
        const expQuery = `
          SELECT 
            ueh.user_id AS "userId",
            COALESCE(u.name, u.username, 'Đạo hữu ẩn danh') AS "userName",
            u.username AS "username",
            u.avatar_url AS "avatarUrl",
            COALESCE(u.sect_rank, 'LUYEN_KHI') AS "sectRank",
            u.current_title AS "currentTitle",
            SUM(ueh.amount)::int AS "totalExpToday",
            MIN(ueh.created_at) AS "earliestAt",
            MAX(ueh.created_at) AS "latestAt",
            COUNT(ueh.id)::int AS "txCount"
          FROM user_exp_histories ueh
          LEFT JOIN users u ON u.id = ueh.user_id
          WHERE ueh.created_at >= $1 AND ueh.created_at <= $2 AND ueh.amount > 0
          GROUP BY ueh.user_id, u.name, u.username, u.avatar_url, u.sect_rank, u.current_title
          ORDER BY "totalExpToday" DESC, "earliestAt" ASC
          LIMIT 10;
        `;
        leaderboard = await this.filmDb.query(expQuery, [start, end]);

        // D. Pending Reports & Comments Count
        const pendingQuery = `
          SELECT 
            (SELECT COUNT(*)::int FROM movie_reports WHERE status = 'PENDING') AS "pendingReports",
            (SELECT COUNT(*)::int FROM comments WHERE status = 'PENDING_MODERATION') AS "pendingComments";
        `;
        const pendingRes = await this.filmDb.query(pendingQuery);
        if (pendingRes?.length) {
          pendingReports = Number(pendingRes[0].pendingReports || 0);
          pendingComments = Number(pendingRes[0].pendingComments || 0);
        }
      } catch (filmErr) {
        this.logger.error(`Failed to scan film database: ${(filmErr as Error).message}`);
      }

      // ==========================================
      // 3. UPSERT INTO REPORT TABLES (reports_xxx)
      // ==========================================
      const trafficRepo = this.filmDb.getRepository(FilmReportDailyTraffic);
      const userRepo = this.filmDb.getRepository(FilmReportDailyUsers);
      const leaderboardRepo = this.filmDb.getRepository(FilmReportDailyExpLeaderboard);
      const contentRepo = this.filmDb.getRepository(FilmReportDailyContent);

      // Upsert Traffic Report
      await trafficRepo.upsert(
        {
          dateKey,
          totalPageViews,
          totalSessions,
          actionSessions,
          actionRate,
          hourlyStats,
          actionsBreakdown,
          topPages,
          topSearches,
          lastScannedAt: new Date(),
        },
        ["dateKey"],
      );

      // Upsert Users Report
      await userRepo.upsert(
        {
          dateKey,
          newUsersCount,
          hourlyNewUsers,
          totalUsers,
          lastScannedAt: new Date(),
        },
        ["dateKey"],
      );

      // Upsert Leaderboard (delete previous for this dateKey then re-insert current ranked order)
      await leaderboardRepo.delete({ dateKey });
      if (leaderboard?.length) {
        const rankEntities = leaderboard.map((row, index) =>
          leaderboardRepo.create({
            dateKey,
            rank: index + 1,
            userId: row.userId,
            userName: row.userName || "Đạo hữu ẩn danh",
            username: row.username || null,
            avatarUrl: row.avatarUrl || null,
            sectRank: row.sectRank || "LUYEN_KHI",
            currentTitle: row.currentTitle || null,
            totalExpToday: Number(row.totalExpToday || 0),
            earliestAt: new Date(row.earliestAt),
            latestAt: new Date(row.latestAt),
            txCount: Number(row.txCount || 1),
          }),
        );
        await leaderboardRepo.save(rankEntities);
      }

      // Upsert Content Report
      await contentRepo.upsert(
        {
          dateKey,
          topWatchedMovies,
          pendingReports,
          pendingComments,
          lastScannedAt: new Date(),
        },
        ["dateKey"],
      );

      const durationMs = Date.now() - t0;
      this.logger.log(`Analytics scan for [${dateKey}] completed in ${durationMs}ms.`);
      return { success: true, dateKey, durationMs };
    } finally {
      this.isScanning = false;
    }
  }
}

