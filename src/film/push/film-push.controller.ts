import { Body, Controller, Delete, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../auth/film-auth";
import { FilmPushPlatform } from "../entities/film.entities";
import { RegisterPushTokenDto, UnregisterPushTokenDto } from "./dto/push-token.dto";
import { FilmPushService } from "./film-push.service";

@Public()
@ApiTags("Film Push Notifications")
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@Controller("film/me/push-tokens")
export class FilmPushController {
  constructor(private readonly pushService: FilmPushService) {}

  @ApiOperation({ summary: "Register or refresh FCM push token for current device/user" })
  @Post()
  register(
    @FilmCurrentUser() user: FilmPrincipal,
    @Body() dto: RegisterPushTokenDto,
    @Req() req: Request,
  ) {
    return this.pushService.registerToken(
      user.userId,
      user.deviceId,
      dto.token,
      dto.platform || FilmPushPlatform.WEB,
      req.get("user-agent") || null,
    );
  }

  @ApiOperation({ summary: "Deactivate FCM push token for current user" })
  @Delete()
  unregister(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: UnregisterPushTokenDto) {
    return this.pushService.unregisterToken(user.userId, dto.token);
  }
}
