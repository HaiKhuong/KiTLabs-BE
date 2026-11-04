import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { SendTestMessageDto } from "./dto/send-test-message.dto";
import { GoogleSheetsService } from "./google-sheets.service";
import { TelegramService } from "./telegram.service";
import { TelegramUserConfigService } from "./telegram-user-config.service";
import { TelegramUpdate } from "./telegram.types";

@ApiTags("Telegram")
@Controller("tools/telegram")
export class TelegramController {
  constructor(
    private readonly telegramService: TelegramService,
    private readonly userConfigService: TelegramUserConfigService,
    private readonly googleSheetsService: GoogleSheetsService,
  ) {}

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
      "Hệ thống đã sẵn sàng nhận ảnh và xuất dữ liệu sang Google Sheets.";

    await this.telegramService.sendMessage(dto.chatId, text, { parse_mode: "Markdown" }, dto.botToken);
    return { ok: true, message: "Đã gửi tin nhắn thử nghiệm thành công" };
  }

  @Public()
  @ApiOperation({ summary: "Webhook nhận sự kiện/lệnh/hình ảnh từ Telegram" })
  @Post("webhook")
  async handleWebhook(@Body() update: TelegramUpdate) {
    if (update) {
      await this.telegramService.handleIncomingUpdate(update);
    }
    return { ok: true };
  }

  @Public()
  @ApiOperation({ summary: "Trạng thái Background Long Polling" })
  @Get("polling/status")
  async getPollingStatus() {
    return {
      active: this.telegramService.isPolling(),
    };
  }

  @Public()
  @ApiOperation({ summary: "Kích hoạt Background Long Polling" })
  @Post("polling/start")
  async startPolling(@Query("token") token?: string) {
    const ok = await this.telegramService.startPolling(token);
    return {
      ok,
      message: ok ? "Đã bật background polling thành công" : "Không thể bật polling (thiếu bot token)",
    };
  }

  @Public()
  @ApiOperation({ summary: "Dừng Background Long Polling" })
  @Post("polling/stop")
  async stopPolling() {
    this.telegramService.stopPolling();
    return { ok: true, message: "Đã dừng background polling" };
  }

  @Public()
  @ApiOperation({ summary: "Danh sách cấu hình Google Sheets & Gemini của từng người dùng" })
  @Get("user-configs")
  async getUserConfigs() {
    return this.userConfigService.findAll();
  }

  @Public()
  @ApiOperation({ summary: "Kiểm tra kết nối tới Google Sheet" })
  @Post("test-sheet")
  async testSheet(
    @Body() body: { spreadsheetId: string; userCredentials?: string },
  ) {
    return this.googleSheetsService.verifyConnection(body.spreadsheetId, body.userCredentials);
  }
}
