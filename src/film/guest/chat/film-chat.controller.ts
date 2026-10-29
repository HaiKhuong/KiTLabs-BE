import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmJwtGuard } from "../../auth/film-auth";
import { FilmChatHistoryQueryDto } from "../../dto/film-chat.dto";
import { FilmChatService } from "./film-chat.service";

@Public()
@ApiBearerAuth("film-bearer")
@UseGuards(FilmJwtGuard)
@ApiTags("Film Guest - Chat")
@Controller("film/chat")
export class FilmChatController {
  constructor(private readonly service: FilmChatService) {}

  @ApiOperation({ summary: "Get chat message history" })
  @Get("history")
  history(@Query() query: FilmChatHistoryQueryDto) {
    return this.service.chatHistory(query.room || "WORLD_GENERAL", query.cursor);
  }
}
