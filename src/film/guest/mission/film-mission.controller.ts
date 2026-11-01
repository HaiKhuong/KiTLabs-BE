import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { ExpHistoryQueryDto } from "./dto/exp-history-query.dto";
import { WatchHeartbeatDto } from "./dto/watch-heartbeat.dto";
import { FilmMissionService } from "./film-mission.service";

@Public()
@ApiTags("Film - Missions & Cultivation EXP")
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@Controller("film/me")
export class FilmMissionController {
  constructor(private readonly missionService: FilmMissionService) {}

  @ApiOperation({ summary: "Lấy danh sách nhiệm vụ và tiến độ hôm nay của người dùng" })
  @Get("missions")
  async getMissions(@FilmCurrentUser() user: FilmPrincipal) {
    // Auto record daily check-in if user visits missions
    await this.missionService.recordCheckin(user.userId);
    const data = await this.missionService.getMissionsWithProgress(user.userId);
    return { success: true, data };
  }

  @ApiOperation({ summary: "Bấm nhận điểm kinh nghiệm từ nhiệm vụ đã hoàn thành" })
  @Post("missions/:code/claim")
  async claimMission(
    @Param("code") code: string,
    @FilmCurrentUser() user: FilmPrincipal,
  ) {
    const result = await this.missionService.claimMission(user.userId, code);
    return { success: true, data: result };
  }

  @ApiOperation({ summary: "Lấy lịch sử cộng điểm kinh nghiệm (timeline feed)" })
  @Get("exp-history")
  async getExpHistory(
    @Query() query: ExpHistoryQueryDto,
    @FilmCurrentUser() user: FilmPrincipal,
  ) {
    const result = await this.missionService.getExpHistory(user.userId, query);
    return { success: true, data: result };
  }

  @ApiOperation({ summary: "Gửi nhịp tim (heartbeat) thời gian xem phim với anti-cheat" })
  @Post("watch-heartbeat")
  async sendWatchHeartbeat(
    @Body() dto: WatchHeartbeatDto,
    @FilmCurrentUser() user: FilmPrincipal,
    @Req() req: Request,
  ) {
    const forwarded = req.headers["x-forwarded-for"];
    const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket?.remoteAddress) || "";
    const userAgent = (req.headers["user-agent"] as string) || "";

    const result = await this.missionService.handleWatchHeartbeat(user.userId, dto, ip, userAgent);
    return { success: true, data: result };
  }
}
