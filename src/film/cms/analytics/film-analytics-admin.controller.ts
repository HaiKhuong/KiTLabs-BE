import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { FilmCmsAccess } from "../shared/film-cms.decorators";
import { FilmAnalyticsAdminService } from "./film-analytics-admin.service";

@FilmCmsAccess()
@ApiTags("Film CMS - Analytics & Reports")
@Controller("film/admin/analytics")
export class FilmAnalyticsAdminController {
  constructor(private readonly analyticsService: FilmAnalyticsAdminService) {}

  @ApiOperation({ summary: "Get aggregated dashboard analytics from pre-computed reports tables" })
  @ApiQuery({ name: "range", required: false, enum: ["today", "yesterday", "7d", "30d"] })
  @ApiQuery({ name: "date", required: false, description: "Specific dateKey YYYY-MM-DD" })
  @Get("dashboard")
  async getDashboard(
    @Query("range") range?: "today" | "yesterday" | "7d" | "30d",
    @Query("date") date?: string,
  ) {
    return this.analyticsService.getDashboardData({ range, date });
  }

  @ApiOperation({ summary: "Manually trigger background scanner to sync raw logs into reports_xxx tables" })
  @Post("sync-now")
  async syncNow(@Body() body?: { dateKey?: string }) {
    return this.analyticsService.triggerManualSync(body?.dateKey);
  }
}

