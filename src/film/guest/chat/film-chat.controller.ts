import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmChatHistoryQueryDto } from "./dto";
import { FilmChatService } from "./film-chat.service";

@Public()
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
