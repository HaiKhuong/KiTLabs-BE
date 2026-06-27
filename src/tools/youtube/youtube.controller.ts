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

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { YouTubeDashboardService } from "./services/dashboard.service";
import { MovieService } from "./services/movie.service";
import { AnalyticsService } from "./services/analytics.service";
import { RecommendationService } from "./services/recommendation.service";
import { AiChatService } from "./services/ai-chat.service";
import { YouTubeSettingsService } from "./services/youtube-settings.service";
import { YouTubeSchedulerService } from "./scheduler/youtube-scheduler.service";
import { CreateMovieDto, UpdateMovieDto, MovieFilterDto } from "./dto/movie.dto";
import { SendMessageDto } from "./dto/chat.dto";
import { AnalyticsQueryDto } from "./dto/analytics.dto";
import { UpdateYouTubeSettingsDto } from "./dto/settings.dto";

@ApiTags("YouTube")
@Controller("youtube")
export class YouTubeController {
  constructor(
    private readonly dashboardService: YouTubeDashboardService,
    private readonly movieService: MovieService,
    private readonly analyticsService: AnalyticsService,
    private readonly recommendationService: RecommendationService,
    private readonly chatService: AiChatService,
    private readonly settingsService: YouTubeSettingsService,
    private readonly schedulerService: YouTubeSchedulerService,
  ) {}

  // === Dashboard ===

  @Get("dashboard")
  @ApiOperation({ summary: "Get dashboard overview data" })
  async getDashboard(@CurrentUser() user: { userId: string }) {
    return this.dashboardService.getDashboardData(user.userId);
  }

  @Get("dashboard/charts")
  @ApiOperation({ summary: "Get dashboard chart data" })
  async getDashboardCharts(
    @CurrentUser() user: { userId: string },
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.dashboardService.getChartData(user.userId, query.startDate, query.endDate);
  }

  // === Movies ===

  @Get("movies")
  @ApiOperation({ summary: "List movies with filters" })
  async getMovies(
    @CurrentUser() user: { userId: string },
    @Query() filter: MovieFilterDto,
  ) {
    return this.movieService.findAll(user.userId, filter);
  }

  @Post("movies")
  @ApiOperation({ summary: "Create a movie" })
  async createMovie(
    @CurrentUser() user: { userId: string },
    @Body() dto: CreateMovieDto,
  ) {
    return this.movieService.create(user.userId, dto);
  }

  @Get("movies/:id")
  @ApiOperation({ summary: "Get movie detail" })
  async getMovie(
    @CurrentUser() user: { userId: string },
    @Param("id") id: string,
  ) {
    return this.movieService.findOne(user.userId, id);
  }

  @Put("movies/:id")
  @ApiOperation({ summary: "Update a movie" })
  async updateMovie(
    @CurrentUser() user: { userId: string },
    @Param("id") id: string,
    @Body() dto: UpdateMovieDto,
  ) {
    return this.movieService.update(user.userId, id, dto);
  }

  @Delete("movies/:id")
  @ApiOperation({ summary: "Delete a movie" })
  async deleteMovie(
    @CurrentUser() user: { userId: string },
    @Param("id") id: string,
  ) {
    return this.movieService.delete(user.userId, id);
  }

  // === Analytics ===

  @Get("analytics")
  @ApiOperation({ summary: "Get channel analytics" })
  async getAnalytics(
    @CurrentUser() user: { userId: string },
    @Query() query: AnalyticsQueryDto,
  ) {
    return this.analyticsService.getChannelAnalytics(user.userId, query);
  }

  @Get("analytics/videos")
  @ApiOperation({ summary: "Get video analytics" })
  async getVideoAnalytics(@CurrentUser() user: { userId: string }) {
    return this.analyticsService.getVideoAnalytics(user.userId);
  }

  @Get("analytics/export")
  @ApiOperation({ summary: "Export analytics CSV" })
  async exportAnalytics(
    @CurrentUser() user: { userId: string },
    @Query() query: AnalyticsQueryDto,
    @Res() res: Response,
  ) {
    const csv = await this.analyticsService.exportCsv(user.userId, query);
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=analytics.csv");
    return res.status(HttpStatus.OK).send(csv);
  }

  // === Recommendations ===

  @Get("recommendations")
  @ApiOperation({ summary: "Get active recommendations" })
  async getRecommendations(@CurrentUser() user: { userId: string }) {
    return this.recommendationService.getActiveRecommendations(user.userId);
  }

  @Post("recommendations/refresh")
  @ApiOperation({ summary: "Manually regenerate recommendations" })
  async refreshRecommendations(@CurrentUser() user: { userId: string }) {
    return this.recommendationService.generateRecommendations(user.userId);
  }

  // === AI Chat ===

  @Post("chat")
  @ApiOperation({ summary: "Send a chat message" })
  async sendMessage(
    @CurrentUser() user: { userId: string },
    @Body() dto: SendMessageDto,
  ) {
    return this.chatService.sendMessage(user.userId, dto.message, dto.chatId);
  }

  @Get("chat/history")
  @ApiOperation({ summary: "Get chat history list" })
  async getChatHistory(@CurrentUser() user: { userId: string }) {
    return this.chatService.getChatHistory(user.userId);
  }

  @Get("chat/:id")
  @ApiOperation({ summary: "Get chat messages" })
  async getChatMessages(
    @CurrentUser() user: { userId: string },
    @Param("id") id: string,
  ) {
    return this.chatService.getChatMessages(user.userId, id);
  }

  @Delete("chat/:id")
  @ApiOperation({ summary: "Delete a chat" })
  async deleteChat(
    @CurrentUser() user: { userId: string },
    @Param("id") id: string,
  ) {
    return this.chatService.deleteChat(user.userId, id);
  }

  // === Settings ===

  @Get("settings")
  @ApiOperation({ summary: "Get YouTube settings" })
  async getSettings(@CurrentUser() user: { userId: string }) {
    return this.settingsService.getSettings(user.userId);
  }

  @Put("settings")
  @ApiOperation({ summary: "Update YouTube settings" })
  async updateSettings(
    @CurrentUser() user: { userId: string },
    @Body() dto: UpdateYouTubeSettingsDto,
  ) {
    return this.settingsService.updateSettings(user.userId, dto);
  }

  // === Manual Sync ===

  @Post("sync/analytics")
  @ApiOperation({ summary: "Manual trigger analytics sync" })
  async syncAnalytics(@CurrentUser() user: { userId: string }) {
    await this.schedulerService.manualSyncAnalytics(user.userId);
    return { message: "Analytics sync completed" };
  }

  @Post("sync/trends")
  @ApiOperation({ summary: "Manual trigger trends sync" })
  async syncTrends(@CurrentUser() user: { userId: string }) {
    await this.schedulerService.manualSyncTrends(user.userId);
    return { message: "Trends sync completed" };
  }
}
