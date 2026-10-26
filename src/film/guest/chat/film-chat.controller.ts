import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmJwtGuard } from "../../auth/film-auth";
import { FilmService } from "../../film.service";

@Public()
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@ApiTags("Film Guest - Chat")
@Controller("film/chat")
export class FilmChatController {
  constructor(private readonly service: FilmService) {}
  @Get("history") history(@Query("room") room = "WORLD_GENERAL", @Query("cursor") cursor?: string) {
    return this.service.chatHistory(room, cursor);
  }
}
