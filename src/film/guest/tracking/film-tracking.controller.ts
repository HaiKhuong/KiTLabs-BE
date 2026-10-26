import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { FilmService } from "../../film.service";
import { ActivityDto } from "../account/film-account.dto";

@Public()
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@ApiTags("Film Guest - Tracking")
@Controller("film/activity-events")
export class FilmTrackingController {
  constructor(private readonly service: FilmService) {}
  @Post() create(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: ActivityDto, @Req() req: Request) {
    return this.service.logActivity(
      user.userId,
      user.deviceId,
      dto,
      req.socket.remoteAddress || null,
      req.get("user-agent") || null,
    );
  }
}
