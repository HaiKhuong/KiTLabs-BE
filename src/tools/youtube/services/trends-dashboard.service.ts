import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Movie } from "../entities/movie.entity";
import { MovieTrend } from "../entities/movie-trend.entity";

export type TrendsMovieItem = {
  id: string;
  chineseName: string;
  vietnameseName: string | null;
  status: string;
  priority: string;
  trendScore: number;
  searchVolume: number;
  trendDelta: number;
  trendDeltaPercent: number;
  lastTrendDate: string | null;
  sparkline: number[];
};

export type TrendsDashboardData = {
  summary: {
    totalMovies: number;
    trackedMovies: number;
    avgTrendScore: number;
    hotMovies: number;
    risingMovies: number;
    decliningMovies: number;
    lastSyncedAt: string | null;
    region: string;
    days: number;
  };
  topByScore: TrendsMovieItem[];
  topRising: TrendsMovieItem[];
  byStatus: { key: string; count: number; avgTrendScore: number }[];
  byPriority: { key: string; count: number; avgTrendScore: number }[];
  timeline: { date: string; avgScore: number; movieCount: number }[];
  multiSeries: {
    dates: string[];
    series: { movieId: string; name: string; data: number[] }[];
  };
  heatmap: {
    dates: string[];
    rows: { movieId: string; name: string; scores: number[] }[];
  };
  allMovies: TrendsMovieItem[];
};

@Injectable()
export class TrendsDashboardService {
  private readonly HOT_SCORE_THRESHOLD = 60;
  private readonly RISING_DELTA_THRESHOLD = 5;

  constructor(
    @InjectRepository(Movie, "tool")
    private readonly movieRepo: Repository<Movie>,
    @InjectRepository(MovieTrend, "tool")
    private readonly trendRepo: Repository<MovieTrend>,
  ) {}

  async getDashboard(userId: string, days = 30, region = "VN"): Promise<TrendsDashboardData> {
    const movies = await this.movieRepo.find({
      where: { userId },
      order: { trendScore: "DESC" },
    });

    if (movies.length === 0) {
      return this.emptyDashboard(days, region);
    }

    const movieIds = movies.map((m) => m.id);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    const startDateStr = startDate.toISOString().split("T")[0];

    const trends = await this.trendRepo
      .createQueryBuilder("trend")
      .where("trend.movie_id IN (:...movieIds)", { movieIds })
      .andWhere("trend.date >= :startDate", { startDate: startDateStr })
      .andWhere("trend.region = :region", { region })
      .orderBy("trend.date", "ASC")
      .getMany();

    const trendsByMovie = new Map<string, MovieTrend[]>();
    for (const trend of trends) {
      const list = trendsByMovie.get(trend.movieId) ?? [];
      list.push(trend);
      trendsByMovie.set(trend.movieId, list);
    }

    const compareDate = new Date();
    compareDate.setDate(compareDate.getDate() - 7);
    const compareDateStr = compareDate.toISOString().split("T")[0];

    const movieItems: TrendsMovieItem[] = movies.map((movie) => {
      const movieTrends = trendsByMovie.get(movie.id) ?? [];
      const latest = movieTrends[movieTrends.length - 1] ?? null;
      const baseline =
        [...movieTrends].reverse().find((t) => t.date <= compareDateStr) ??
        movieTrends[0] ??
        null;

      const currentScore = latest?.trendScore ?? Number(movie.trendScore) ?? 0;
      const baselineScore = baseline?.trendScore ?? currentScore;
      const delta = currentScore - baselineScore;
      const deltaPercent = baselineScore > 0 ? Number(((delta / baselineScore) * 100).toFixed(1)) : 0;

      const sparklineDays = Math.min(14, days);
      const sparkStart = new Date();
      sparkStart.setDate(sparkStart.getDate() - sparklineDays);
      const sparkStartStr = sparkStart.toISOString().split("T")[0];
      const sparkline = movieTrends
        .filter((t) => t.date >= sparkStartStr)
        .map((t) => t.trendScore);

      return {
        id: movie.id,
        chineseName: movie.chineseName,
        vietnameseName: movie.vietnameseName,
        status: movie.status,
        priority: movie.priority,
        trendScore: currentScore,
        searchVolume: latest?.searchVolume ?? 0,
        trendDelta: delta,
        trendDeltaPercent: deltaPercent,
        lastTrendDate: latest?.date ?? null,
        sparkline,
      };
    });

    const trackedMovies = movieItems.filter((m) => m.lastTrendDate).length;
    const avgTrendScore =
      movieItems.length > 0
        ? Number((movieItems.reduce((sum, m) => sum + m.trendScore, 0) / movieItems.length).toFixed(1))
        : 0;

    const lastSyncedAt =
      trends.length > 0 ? trends[trends.length - 1].date : null;

    const summary = {
      totalMovies: movies.length,
      trackedMovies,
      avgTrendScore,
      hotMovies: movieItems.filter((m) => m.trendScore >= this.HOT_SCORE_THRESHOLD).length,
      risingMovies: movieItems.filter((m) => m.trendDelta >= this.RISING_DELTA_THRESHOLD).length,
      decliningMovies: movieItems.filter((m) => m.trendDelta <= -this.RISING_DELTA_THRESHOLD).length,
      lastSyncedAt,
      region,
      days,
    };

    const topByScore = [...movieItems].sort((a, b) => b.trendScore - a.trendScore).slice(0, 15);
    const topRising = [...movieItems]
      .filter((m) => m.lastTrendDate)
      .sort((a, b) => b.trendDelta - a.trendDelta)
      .slice(0, 10);

    const byStatus = this.groupByField(movieItems, "status");
    const byPriority = this.groupByField(movieItems, "priority");

    const timeline = this.buildTimeline(trends);
    const multiSeries = this.buildMultiSeries(movieItems, trendsByMovie, days);
    const heatmap = this.buildHeatmap(movieItems, trendsByMovie);

    return {
      summary,
      topByScore,
      topRising,
      byStatus,
      byPriority,
      timeline,
      multiSeries,
      heatmap,
      allMovies: movieItems,
    };
  }

  private emptyDashboard(days: number, region: string): TrendsDashboardData {
    return {
      summary: {
        totalMovies: 0,
        trackedMovies: 0,
        avgTrendScore: 0,
        hotMovies: 0,
        risingMovies: 0,
        decliningMovies: 0,
        lastSyncedAt: null,
        region,
        days,
      },
      topByScore: [],
      topRising: [],
      byStatus: [],
      byPriority: [],
      timeline: [],
      multiSeries: { dates: [], series: [] },
      heatmap: { dates: [], rows: [] },
      allMovies: [],
    };
  }

  private groupByField(
    items: TrendsMovieItem[],
    field: "status" | "priority",
  ): { key: string; count: number; avgTrendScore: number }[] {
    const map = new Map<string, { count: number; total: number }>();

    for (const item of items) {
      const key = item[field];
      const entry = map.get(key) ?? { count: 0, total: 0 };
      entry.count += 1;
      entry.total += item.trendScore;
      map.set(key, entry);
    }

    return [...map.entries()]
      .map(([key, val]) => ({
        key,
        count: val.count,
        avgTrendScore: val.count > 0 ? Number((val.total / val.count).toFixed(1)) : 0,
      }))
      .sort((a, b) => b.avgTrendScore - a.avgTrendScore);
  }

  private buildTimeline(trends: MovieTrend[]): { date: string; avgScore: number; movieCount: number }[] {
    const byDate = new Map<string, number[]>();

    for (const trend of trends) {
      const scores = byDate.get(trend.date) ?? [];
      scores.push(trend.trendScore);
      byDate.set(trend.date, scores);
    }

    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, scores]) => ({
        date,
        avgScore: Number((scores.reduce((s, v) => s + v, 0) / scores.length).toFixed(1)),
        movieCount: scores.length,
      }));
  }

  private buildMultiSeries(
    movieItems: TrendsMovieItem[],
    trendsByMovie: Map<string, MovieTrend[]>,
    days: number,
  ): { dates: string[]; series: { movieId: string; name: string; data: number[] }[] } {
    const topMovies = [...movieItems]
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, 8);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - Math.min(days, 30));
    const dates: string[] = [];
    const cursor = new Date(startDate);
    const end = new Date();
    while (cursor <= end) {
      dates.push(cursor.toISOString().split("T")[0]);
      cursor.setDate(cursor.getDate() + 1);
    }

    const series = topMovies.map((movie) => {
      const trendMap = new Map(
        (trendsByMovie.get(movie.id) ?? []).map((t) => [t.date, t.trendScore]),
      );
      const displayName = movie.vietnameseName ?? movie.chineseName;
      return {
        movieId: movie.id,
        name: displayName.length > 28 ? `${displayName.slice(0, 28)}…` : displayName,
        data: dates.map((date) => trendMap.get(date) ?? 0),
      };
    });

    return { dates, series };
  }

  private buildHeatmap(
    movieItems: TrendsMovieItem[],
    trendsByMovie: Map<string, MovieTrend[]>,
  ): { dates: string[]; rows: { movieId: string; name: string; scores: number[] }[] } {
    const heatmapDays = 14;
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - heatmapDays);
    const dates: string[] = [];
    const cursor = new Date(startDate);
    const end = new Date();
    while (cursor <= end) {
      dates.push(cursor.toISOString().split("T")[0]);
      cursor.setDate(cursor.getDate() + 1);
    }

    const topMovies = [...movieItems]
      .sort((a, b) => b.trendScore - a.trendScore)
      .slice(0, 12);

    const rows = topMovies.map((movie) => {
      const trendMap = new Map(
        (trendsByMovie.get(movie.id) ?? []).map((t) => [t.date, t.trendScore]),
      );
      const displayName = movie.vietnameseName ?? movie.chineseName;
      return {
        movieId: movie.id,
        name: displayName.length > 22 ? `${displayName.slice(0, 22)}…` : displayName,
        scores: dates.map((date) => trendMap.get(date) ?? 0),
      };
    });

    return { dates, rows };
  }
}
