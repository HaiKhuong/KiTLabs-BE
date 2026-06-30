import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Response } from "express";

import { Public } from "../../common/decorators/public.decorator";
import { YouTubeDashboardService } from "./services/dashboard.service";
import { MovieService } from "./services/movie.service";
import { AnalyticsService } from "./services/analytics.service";
import { RecommendationService } from "./services/recommendation.service";
import { YouTubeSettingsService } from "./services/youtube-settings.service";
import { YouTubeSchedulerService } from "./scheduler/youtube-scheduler.service";
import { CreateMovieDto, UpdateMovieDto, MovieFilterDto } from "./dto/movie.dto";
import { AnalyticsQueryDto } from "./dto/analytics.dto";
import { UpdateYouTubeSettingsDto } from "./dto/settings.dto";
import { TrendsDashboardQueryDto } from "./dto/trends.dto";
import { requireUserId } from "./utils/require-user-id";
import { TrendsDashboardService } from "./services/trends-dashboard.service";

@ApiTags("YouTube")
@Controller("youtube")
export class YouTubeController {
  constructor(
    private readonly dashboardService: YouTubeDashboardService,
    private readonly movieService: MovieService,
    private readonly analyticsService: AnalyticsService,
    private readonly recommendationService: RecommendationService,
    private readonly settingsService: YouTubeSettingsService,
    private readonly schedulerService: YouTubeSchedulerService,
    private readonly trendsDashboardService: TrendsDashboardService,
  ) {}

  // === Dashboard ===

  @Public()
  @Get("dashboard")
  @ApiOperation({ summary: "Get dashboard overview data" })
  async getDashboard(@Query("userId") userId?: string) {
    return this.dashboardService.getDashboardData(requireUserId(userId));
  }

  @Public()
  @Get("dashboard/charts")
  @ApiOperation({ summary: "Get dashboard chart data" })
  async getDashboardCharts(
    @Query("userId") userId: string | undefined,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.dashboardService.getChartData(requireUserId(userId), query.startDate, query.endDate);
  }

  // === Movies ===

  @Public()
  @Get("movies")
  @ApiOperation({ summary: "List movies with filters" })
  async getMovies(
    @Query("userId") userId: string | undefined,
    @Query() filter: MovieFilterDto,
  ) {
    return this.movieService.findAll(requireUserId(userId), filter);
  }

  @Public()
  @Post("movies")
  @ApiOperation({ summary: "Create a movie" })
  async createMovie(
    @Query("userId") userId: string | undefined,
    @Body() dto: CreateMovieDto,
  ) {
    return this.movieService.create(requireUserId(userId), dto);
  }

  @Public()
  @Get("movies/:id")
  @ApiOperation({ summary: "Get movie detail" })
  async getMovie(
    @Query("userId") userId: string | undefined,
    @Param("id") id: string,
  ) {
    return this.movieService.findOne(requireUserId(userId), id);
  }

  @Public()
  @Put("movies/:id")
  @ApiOperation({ summary: "Update a movie" })
  async updateMovie(
    @Query("userId") userId: string | undefined,
    @Param("id") id: string,
    @Body() dto: UpdateMovieDto,
  ) {
    return this.movieService.update(requireUserId(userId), id, dto);
  }

  @Public()
  @Delete("movies/:id")
  @ApiOperation({ summary: "Delete a movie" })
  async deleteMovie(
    @Query("userId") userId: string | undefined,
    @Param("id") id: string,
  ) {
    return this.movieService.delete(requireUserId(userId), id);
  }

  // === Analytics ===

  @Public()
  @Get("analytics")
  @ApiOperation({ summary: "Get channel analytics" })
  async getAnalytics(
    @Query("userId") userId: string | undefined,
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.analyticsService.getChannelAnalytics(requireUserId(userId), query);
  }

  @Public()
  @Get("analytics/videos")
  @ApiOperation({ summary: "Get video analytics" })
  async getVideoAnalytics(@Query("userId") userId?: string) {
    return this.analyticsService.getVideoAnalytics(requireUserId(userId));
  }

  @Public()
  @Get("analytics/export")
  @ApiOperation({ summary: "Export analytics CSV" })
  async exportAnalytics(
    @Query("userId") userId: string | undefined,
    @Query() query: AnalyticsQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.analyticsService.exportCsv(requireUserId(userId), query);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=analytics.csv");
    return res.status(HttpStatus.OK).send(csv);
  }

  // === Recommendations ===

  @Public()
  @Get("recommendations")
  @ApiOperation({ summary: "Get active recommendations" })
  async getRecommendations(@Query("userId") userId?: string) {
    return this.recommendationService.getActiveRecommendations(requireUserId(userId));
  }

  @Public()
  @Post("recommendations/refresh")
  @ApiOperation({ summary: "Manually regenerate recommendations" })
  async refreshRecommendations(@Query("userId") userId?: string) {
    return this.recommendationService.generateRecommendations(requireUserId(userId));
  }

  // === Settings ===

  @Public()
  @Get("settings")
  @ApiOperation({ summary: "Get YouTube settings" })
  async getSettings(@Query("userId") userId?: string) {
    return this.settingsService.getSettings(requireUserId(userId));
  }

  @Public()
  @Put("settings")
  @ApiOperation({ summary: "Update YouTube settings" })
  async updateSettings(
    @Query("userId") userId: string | undefined,
    @Body() dto: UpdateYouTubeSettingsDto,
  ) {
    return this.settingsService.updateSettings(requireUserId(userId), dto);
  }

  // === Trends ===

  @Public()
  @Get("trends/dashboard")
  @ApiOperation({ summary: "Get Google Trends dashboard data" })
  async getTrendsDashboard(
    @Query("userId") userId: string | undefined,
    @Query() query: TrendsDashboardQueryDto,
  ) {
    return this.trendsDashboardService.getDashboard(
      requireUserId(userId),
      query.days ?? 30,
      query.region ?? "VN",
    );
  }

  // === Manual Sync ===

  @Public()
  @Post("sync/analytics")
  @ApiOperation({ summary: "Manual trigger analytics sync" })
  async syncAnalytics(@Query("userId") userId?: string) {
    await this.schedulerService.manualSyncAnalytics(requireUserId(userId));
    return { message: "Analytics sync completed" };
  }

  @Public()
  @Post("sync/trends")
  @ApiOperation({ summary: "Manual trigger trends sync" })
  async syncTrends(@Query("userId") userId?: string) {
    await this.schedulerService.manualSyncTrends(requireUserId(userId));
    return { message: "Trends sync completed" };
  }
}
