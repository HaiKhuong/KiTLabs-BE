import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { FilmService } from "../../film.service";
import { ActivityDto, CommentDto, MovieDto, RatingDto, ReactionDto, WatchDto } from "./film-account.dto";

@Public()
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@ApiTags("Film Guest - Account")
@Controller("film/me")
export class FilmAccountController {
  constructor(private readonly service: FilmService) {}
  @Put("watch-progress") watch(@FilmCurrentUser() u: FilmPrincipal, @Body() dto: WatchDto) {
    return this.service.saveWatch(u.userId, dto);
  }
  @Get("watch-history") history(@FilmCurrentUser() u: FilmPrincipal) {
    return this.service.history(u.userId);
  }
  @Post("favorites") favorite(@FilmCurrentUser() u: FilmPrincipal, @Body() dto: MovieDto) {
    return this.service.favorite(u.userId, dto.movieId);
  }
  @Get("favorites") favorites(@FilmCurrentUser() u: FilmPrincipal) {
    return this.service.favorites(u.userId);
  }
  @Put("ratings") rate(@FilmCurrentUser() u: FilmPrincipal, @Body() dto: RatingDto) {
    return this.service.rate(u.userId, dto);
  }
  @Post("comments") comment(@FilmCurrentUser() u: FilmPrincipal, @Body() dto: CommentDto) {
    return this.service.comment(u.userId, dto);
  }
  @Put("comments/:id/reaction") react(
    @FilmCurrentUser() u: FilmPrincipal,
    @Param("id") id: string,
    @Body() dto: ReactionDto,
  ) {
    return this.service.react(u.userId, id, dto.type);
  }
  @Get("inventory") inventory(@FilmCurrentUser() u: FilmPrincipal) {
    return this.service.inventory(u.userId);
  }
  @Get("notifications") notifications(@FilmCurrentUser() u: FilmPrincipal) {
    return this.service.notifications(u.userId);
  }
  @Get("donations") donations(@FilmCurrentUser() u: FilmPrincipal) {
    return this.service.donations(u.userId);
  }
  @Post("activity-events") activity(
    @FilmCurrentUser() u: FilmPrincipal,
    @Body() dto: ActivityDto,
    @Req() req: Request,
  ) {
    return this.service.logActivity(
      u.userId,
      u.deviceId,
      dto,
      req.socket.remoteAddress || null,
      req.get("user-agent") || null,
    );
  }
}
