import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { SendTestMessageDto } from "./dto/send-test-message.dto";
import { TelegramService } from "./telegram.service";
import { TelegramUpdate } from "./telegram.types";

@ApiTags("Telegram")
@Controller("tools/telegram")
export class TelegramController {
  constructor(private readonly telegramService: TelegramService) {}

  @Public()
  @ApiOperation({ summary: "Kiểm tra thông tin Telegram Bot" })
  @ApiQuery({ name: "token", required: false, description: "Token tạm thời" })
  @Get("me")
  async getMe(@Query("token") token?: string) {
    return this.telegramService.getMe(token);
  }

  @Public()
  @ApiOperation({ summary: "Quét tin nhắn gần đây để tự động lấy Chat ID" })
  @ApiQuery({ name: "token", required: false, description: "Token tạm thời" })
  @Get("recent-chats")
  async getRecentChats(@Query("token") token?: string) {
    return this.telegramService.getRecentChats(token);
  }

  @Public()
  @ApiOperation({ summary: "Gửi tin nhắn thử nghiệm để kiểm tra Bot và Chat ID" })
  @Post("send-test")
  async sendTestMessage(@Body() dto: SendTestMessageDto) {
    const text =
      dto.message?.trim() ||
      "🔔 *KiTLabs Test Notification*\n\n" +
      "Kết nối Telegram Bot thành công!\n" +
      "Hệ thống sẽ gửi thông báo đến Chat ID này mỗi khi đăng bài Facebook thành công.";

    await this.telegramService.sendMessage(dto.chatId, text, { parse_mode: "Markdown" }, dto.botToken);
    return { ok: true, message: "Đã gửi tin nhắn thử nghiệm thành công" };
  }

  @Public()
  @ApiOperation({ summary: "Webhook nhận sự kiện/lệnh từ Telegram (dành cho tương lai)" })
  @Post("webhook")
  async handleWebhook(@Body() update: TelegramUpdate) {
    if (update?.message) {
      const bot = await this.telegramService.getMe();
      await this.telegramService.handleIncomingMessage(update.message, bot);
    }
    return { ok: true };
  }
}

