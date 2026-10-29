import { Body, Controller, Get, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { FilmTrackingService } from "../tracking/film-tracking.service";
import { ActivityDto, CommentDto, MovieDto, RatingDto, ReactionDto, WatchDto } from "./film-account.dto";
import { FilmAccountService } from "./film-account.service";

@Public()
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@ApiTags("Film Guest - Account")
@Controller("film/me")
export class FilmAccountController {
  constructor(
    private readonly service: FilmAccountService,
    private readonly trackingService: FilmTrackingService,
  ) {}

  @ApiOperation({ summary: "Save movie watch progress" })
  @Put("watch-progress")
  watch(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: WatchDto) {
    return this.service.saveWatch(user.userId, dto);
  }

  @ApiOperation({ summary: "Get user watch history" })
  @Get("watch-history")
  history(@FilmCurrentUser() user: FilmPrincipal) {
    return this.service.history(user.userId);
  }

  @ApiOperation({ summary: "Toggle movie favorite status" })
  @Post("favorites")
  favorite(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: MovieDto) {
    return this.service.favorite(user.userId, dto.movieId);
  }

  @ApiOperation({ summary: "Get user favorite movies list" })
  @Get("favorites")
  favorites(@FilmCurrentUser() user: FilmPrincipal) {
    return this.service.favorites(user.userId);
  }

  @ApiOperation({ summary: "Rate a movie" })
  @Put("ratings")
  rate(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: RatingDto) {
    return this.service.rate(user.userId, dto);
  }

  @ApiOperation({ summary: "Post a new comment on a movie" })
  @Post("comments")
  comment(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: CommentDto) {
    return this.service.comment(user.userId, dto);
  }

  @ApiOperation({ summary: "React (like/dislike) to a comment" })
  @ApiParam({ name: "id", description: "Comment UUID" })
  @Put("comments/:id/reaction")
  react(
    @FilmCurrentUser() user: FilmPrincipal,
    @Param("id") id: string,
    @Body() dto: ReactionDto,
  ) {
    return this.service.react(user.userId, id, dto.type);
  }

  @ApiOperation({ summary: "Get user inventory items" })
  @Get("inventory")
  inventory(@FilmCurrentUser() user: FilmPrincipal) {
    return this.service.inventory(user.userId);
  }

  @ApiOperation({ summary: "Get user notifications" })
  @Get("notifications")
  notifications(@FilmCurrentUser() user: FilmPrincipal) {
    return this.service.notifications(user.userId);
  }

  @ApiOperation({ summary: "Get user donation history" })
  @Get("donations")
  donations(@FilmCurrentUser() user: FilmPrincipal) {
    return this.service.donations(user.userId);
  }

  @ApiOperation({ summary: "Log user activity event" })
  @Post("activity-events")
  activity(
    @FilmCurrentUser() user: FilmPrincipal,
    @Body() dto: ActivityDto,
    @Req() req: Request,
  ) {
    return this.trackingService.logActivity(
      user.userId,
      user.deviceId,
      dto,
      req.socket.remoteAddress || null,
      req.get("user-agent") || null,
    );
  }
}
