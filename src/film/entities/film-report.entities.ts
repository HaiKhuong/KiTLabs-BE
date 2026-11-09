import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

@Entity("reports_daily_traffic")
export class FilmReportDailyTraffic {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index({ unique: true })
  @Column({ name: "date_key", type: "varchar", length: 10 })
  dateKey!: string; // 'YYYY-MM-DD'

  @Column({ name: "total_page_views", type: "int", default: 0 })
  totalPageViews!: number;

  @Column({ name: "total_sessions", type: "int", default: 0 })
  totalSessions!: number;

  @Column({ name: "action_sessions", type: "int", default: 0 })
  actionSessions!: number;

  @Column({ name: "action_rate", type: "numeric", precision: 5, scale: 2, default: 0 })
  actionRate!: number;

  @Column({ name: "hourly_stats", type: "jsonb", default: () => "'[]'" })
  hourlyStats!: Array<{ hour: number; views: number; actionSessions: number }>;

  @Column({ name: "actions_breakdown", type: "jsonb", default: () => "'{}'" })
  actionsBreakdown!: Record<string, number>;

  @Column({ name: "top_pages", type: "jsonb", default: () => "'[]'" })
  topPages!: Array<{ path: string; views: number }>;

  @Column({ name: "top_searches", type: "jsonb", default: () => "'[]'" })
  topSearches!: Array<{ keyword: string; count: number }>;

  @Column({ name: "last_scanned_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  lastScannedAt!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}

@Entity("reports_daily_users")
export class FilmReportDailyUsers {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index({ unique: true })
  @Column({ name: "date_key", type: "varchar", length: 10 })
  dateKey!: string; // 'YYYY-MM-DD'

  @Column({ name: "new_users_count", type: "int", default: 0 })
  newUsersCount!: number;

  @Column({ name: "hourly_new_users", type: "jsonb", default: () => "'[]'" })
  hourlyNewUsers!: Array<{ hour: number; count: number }>;

  @Column({ name: "total_users", type: "int", default: 0 })
  totalUsers!: number;

  @Column({ name: "last_scanned_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  lastScannedAt!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}

@Index(["dateKey", "rank"], { unique: true })
@Entity("reports_daily_exp_leaderboard")
export class FilmReportDailyExpLeaderboard {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index()
  @Column({ name: "date_key", type: "varchar", length: 10 })
  dateKey!: string; // 'YYYY-MM-DD'

  @Column({ type: "int" })
  rank!: number;

  @Index()
  @Column("uuid", { name: "user_id" })
  userId!: string;

  @Column({ name: "user_name", type: "varchar", length: 150 })
  userName!: string;

  @Column({ type: "varchar", length: 100, nullable: true })
  username!: string | null;

  @Column({ name: "avatar_url", type: "text", nullable: true })
  avatarUrl!: string | null;

  @Column({ name: "sect_rank", type: "varchar", length: 50, default: "LUYEN_KHI" })
  sectRank!: string;

  @Column({ name: "current_title", type: "varchar", length: 150, nullable: true })
  currentTitle!: string | null;

  @Column({ name: "total_exp_today", type: "int", default: 0 })
  totalExpToday!: number;

  @Column({ name: "earliest_at", type: "timestamptz" })
  earliestAt!: Date;

  @Column({ name: "latest_at", type: "timestamptz" })
  latestAt!: Date;

  @Column({ name: "tx_count", type: "int", default: 1 })
  txCount!: number;

  @Column({ name: "exp_sources", type: "jsonb", nullable: true })
  expSources!: Record<string, number> | null;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}

@Entity("reports_daily_content")
export class FilmReportDailyContent {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index({ unique: true })
  @Column({ name: "date_key", type: "varchar", length: 10 })
  dateKey!: string; // 'YYYY-MM-DD'

  @Column({ name: "top_watched_movies", type: "jsonb", default: () => "'[]'" })
  topWatchedMovies!: Array<{
    movieId: string;
    title: string;
    slug?: string;
    bannerUrl?: string | null;
    views: number;
  }>;

  @Column({ name: "pending_reports", type: "int", default: 0 })
  pendingReports!: number;

  @Column({ name: "pending_comments", type: "int", default: 0 })
  pendingComments!: number;

  @Column({ name: "last_scanned_at", type: "timestamptz", default: () => "CURRENT_TIMESTAMP" })
  lastScannedAt!: Date;

  @CreateDateColumn({ name: "created_at" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at" })
  updatedAt!: Date;
}

export const FILM_REPORT_ENTITIES = [
  FilmReportDailyTraffic,
  FilmReportDailyUsers,
  FilmReportDailyExpLeaderboard,
  FilmReportDailyContent,
];

