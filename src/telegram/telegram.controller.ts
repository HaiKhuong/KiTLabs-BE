import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../common/decorators/public.decorator";
import { PlatformAdminGuard } from "../platform/credentials/platform-admin.guard";
import { TelegramService } from "./telegram.service";

export interface TelegramTestDto {
  botToken?: string;
  chatId?: string;
  message?: string;
}

@ApiTags("Platform Telegram")
@Controller("platform/telegram")
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("test")
  async testConnection(@Body() body: TelegramTestDto) {
    return this.telegramService.testConnection(body.botToken, body.chatId, body.message);
  }
}

