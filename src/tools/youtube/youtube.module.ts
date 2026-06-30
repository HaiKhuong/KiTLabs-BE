import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ScheduleModule } from "@nestjs/schedule";

import { YouTubeChannel } from "./entities/youtube-channel.entity";
import { YouTubeVideo } from "./entities/youtube-video.entity";
import { Movie } from "./entities/movie.entity";
import { MovieTrend } from "./entities/movie-trend.entity";
import { AnalyticsSnapshot } from "./entities/analytics-snapshot.entity";
import { Recommendation } from "./entities/recommendation.entity";
import { Setting } from "../settings/setting.entity";

import { YouTubeController } from "./youtube.controller";
import { YouTubeAuthController } from "./auth/youtube-auth.controller";

import { GoogleOAuthService } from "./auth/google-oauth.service";
import { YouTubeAuthService } from "./auth/youtube-auth.service";
import { YouTubeApiService } from "./services/youtube-api.service";
import { TrendsService } from "./services/trends.service";
import { RecommendationService } from "./services/recommendation.service";
import { YouTubeDashboardService } from "./services/dashboard.service";
import { MovieService } from "./services/movie.service";
import { AnalyticsService } from "./services/analytics.service";
import { YouTubeSettingsService } from "./services/youtube-settings.service";
import { YouTubeSchedulerService } from "./scheduler/youtube-scheduler.service";
import { TrendsDashboardService } from "./services/trends-dashboard.service";

import { AiService } from "./ai/ai.service";
import { GeminiProvider } from "./ai/gemini.provider";

import { DatabaseModule } from "../../database/database.module";

@Module({
  imports: [
    ScheduleModule.forRoot(),
    TypeOrmModule.forFeature(
      [
        YouTubeChannel,
        YouTubeVideo,
        Movie,
        MovieTrend,
        AnalyticsSnapshot,
        Recommendation,
        Setting,
      ],
      "tool",
    ),
    DatabaseModule,
  ],
  controllers: [YouTubeController, YouTubeAuthController],
  providers: [
    GoogleOAuthService,
    YouTubeAuthService,
    YouTubeApiService,
    TrendsService,
    RecommendationService,
    YouTubeDashboardService,
    MovieService,
    AnalyticsService,
    YouTubeSettingsService,
    YouTubeSchedulerService,
    TrendsDashboardService,
    AiService,
    GeminiProvider,
  ],
  exports: [YouTubeAuthService, YouTubeApiService],
})
export class YouTubeModule {}
