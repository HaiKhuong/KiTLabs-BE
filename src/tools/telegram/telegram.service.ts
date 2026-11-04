import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import axios, { AxiosError } from "axios";

import { AppConfigService } from "../../common/config/app-config.service";
import {
  TelegramBotInfo,
  TelegramDetectedChat,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram.types";

export type TelegramCommandHandler = (message: TelegramMessage, bot: TelegramBotInfo) => Promise<string | void>;

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly commandHandlers = new Map<string, TelegramCommandHandler>();

  constructor(private readonly appConfig: AppConfigService) {
    this.registerDefaultCommands();
  }

  /**
   * Lấy Bot Token từ AppConfig hoặc nhận token tạm thời được truyền vào
   */
  resolveToken(customToken?: string): string {
    const raw = (customToken?.trim() || this.appConfig.getSecret("TELEGRAM_BOT_TOKEN")).trim();
    // Hệ thống chỉ hỗ trợ 1 token duy nhất
    return raw.split(/[,;\s]+/)[0]?.trim() ?? "";
  }

  /**
   * Lấy thông tin Bot (kiểm tra token có hợp lệ không)
   */
  async getMe(customToken?: string): Promise<TelegramBotInfo> {
    const token = this.resolveToken(customToken);
    if (!token) {
      throw new BadRequestException("Chưa cấu hình Telegram Bot Token");
    }

    try {
      const response = await axios.get<{ ok: boolean; result: TelegramBotInfo }>(
        `https://api.telegram.org/bot${token}/getMe`,
        { timeout: 8000 },
      );
      if (!response.data.ok) {
        throw new BadRequestException("Bot Token không hợp lệ hoặc đã bị vô hiệu hóa");
      }
      return response.data.result;
    } catch (error) {
      this.handleAxiosError(error, "Không thể xác thực Bot Token");
    }
  }

  /**
   * Lấy các bản tin cập nhật gần đây gửi đến bot (để phát hiện Chat ID)
   */
  async getUpdates(
    options: { offset?: number; limit?: number; timeout?: number } = {},
    customToken?: string,
  ): Promise<TelegramUpdate[]> {
    const token = this.resolveToken(customToken);
    if (!token) {
      throw new BadRequestException("Chưa cấu hình Telegram Bot Token");
    }

    try {
      const response = await axios.get<{ ok: boolean; result: TelegramUpdate[] }>(
        `https://api.telegram.org/bot${token}/getUpdates`,
        {
          params: {
            offset: options.offset,
            limit: options.limit ?? 50,
            timeout: options.timeout ?? 0,
          },
          timeout: 10_000,
        },
      );
      return response.data.ok ? response.data.result : [];
    } catch (error) {
      this.handleAxiosError(error, "Không thể lấy danh sách tin nhắn từ Telegram");
    }
  }

  /**
   * Quét và trích xuất danh sách các cuộc trò chuyện (Chat IDs) gần nhất
   */
  async getRecentChats(customToken?: string): Promise<{ bot: TelegramBotInfo; chats: TelegramDetectedChat[] }> {
    const bot = await this.getMe(customToken);
    const updates = await this.getUpdates({ limit: 100 }, customToken);

    const chatMap = new Map<string, TelegramDetectedChat>();

    for (const update of updates) {
      const msg = update.message || update.channel_post || update.edited_message;
      if (!msg?.chat) continue;

      const chatId = String(msg.chat.id);
      const title =
        msg.chat.title ||
        [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") ||
        msg.chat.username ||
        `Chat ${chatId}`;

      const dateStr = msg.date ? new Date(msg.date * 1000).toLocaleString("vi-VN") : undefined;

      chatMap.set(chatId, {
        chatId,
        type: msg.chat.type,
        title,
        username: msg.chat.username,
        lastMessage: msg.text || (msg.from?.is_bot ? "[Bot action]" : "[Tệp/Hình ảnh]"),
        lastMessageDate: dateStr,
      });

      // Tự động xử lý lệnh nếu người dùng gửi lệnh tới bot
      if (msg.text?.startsWith("/")) {
        void this.handleIncomingMessage(msg, bot, customToken);
      }
    }

    return {
      bot,
      chats: Array.from(chatMap.values()).reverse(),
    };
  }

  /**
   * Gửi tin nhắn qua Telegram
   */
  async sendMessage(
    chatId: string,
    text: string,
    options: { parse_mode?: "Markdown" | "HTML"; disable_web_page_preview?: boolean } = {},
    customToken?: string,
  ): Promise<boolean> {
    const token = this.resolveToken(customToken);
    const targetChatId = chatId.split(/[,;\s]+/)[0]?.trim();
    if (!token || !targetChatId) {
      throw new BadRequestException("Thiếu Bot Token hoặc Chat ID");
    }

    try {
      const response = await axios.post<{ ok: boolean }>(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: targetChatId,
          text,
          parse_mode: options.parse_mode ?? "Markdown",
          disable_web_page_preview: options.disable_web_page_preview ?? false,
        },
        { timeout: 10_000 },
      );
      return response.data.ok === true;
    } catch (error) {
      this.handleAxiosError(error, `Không gửi được tin nhắn tới Chat ID: ${targetChatId}`);
    }
  }

  /**
   * Đăng ký xử lý lệnh tương lai (Bot command handler)
   */
  registerCommandHandler(command: string, handler: TelegramCommandHandler): void {
    const normalized = command.startsWith("/") ? command.slice(1).toLowerCase() : command.toLowerCase();
    this.commandHandlers.set(normalized, handler);
  }

  /**
   * Xử lý tin nhắn đến (tự động phản hồi chat ID và hỗ trợ mở rộng lệnh sau này)
   */
  async handleIncomingMessage(msg: TelegramMessage, bot: TelegramBotInfo, customToken?: string): Promise<void> {
    if (!msg.text || !msg.chat) return;
    const text = msg.text.trim();
    const commandPart = text.split(" ")[0].toLowerCase();
    const commandName = commandPart.startsWith("/") ? commandPart.slice(1).split("@")[0] : "";

    const handler = this.commandHandlers.get(commandName);
    if (handler) {
      try {
        const reply = await handler(msg, bot);
        if (reply && typeof reply === "string") {
          await this.sendMessage(String(msg.chat.id), reply, { parse_mode: "Markdown" }, customToken);
        }
      } catch (err) {
        this.logger.error(`Error handling command /${commandName}:`, err);
      }
    }
  }

  private registerDefaultCommands(): void {
    // Lệnh /chatid hoặc /id: Trả về chính xác Chat ID
    const respondId: TelegramCommandHandler = async (msg) => {
      const name = msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : "bạn";
      return (
        `👋 Chào *${name}*!\n\n` +
        `🆔 *Chat ID của bạn:* \`${msg.chat.id}\`\n` +
        `📋 *Loại phòng:* \`${msg.chat.type}\`\n\n` +
        `💡 Bạn hãy sao chép dãy số ID trên và dán vào ô *TELEGRAM_CHAT_ID* trong phần Cài đặt KiTLabs.`
      );
    };

    this.registerCommandHandler("chatid", respondId);
    this.registerCommandHandler("id", respondId);

    // Lệnh /start: Lời chào và hướng dẫn
    this.registerCommandHandler("start", async (msg, bot) => {
      const name = msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : "bạn";
      return (
        `🤖 *KiTLabs Notification Bot* sẵn sàng!\n\n` +
        `Chào mừng *${name}*! Bot này kết nối với hệ thống KiTLabs để gửi thông báo tự động khi xuất bản video Facebook thành công.\n\n` +
        `🆔 *Chat ID:* \`${msg.chat.id}\`\n\n` +
        `👉 Hãy dán Chat ID này vào mục *Cấu hình RunTime* trên ứng dụng để nhận thông báo.`
      );
    });

    // Lệnh /help: Danh sách lệnh
    this.registerCommandHandler("help", async () => {
      return (
        `📖 *Danh sách lệnh Bot:*\n` +
        `• \`/start\` - Khởi động và kiểm tra kết nối\n` +
        `• \`/chatid\` hoặc \`/id\` - Lấy Chat ID phòng hiện tại\n` +
        `• \`/help\` - Xem hướng dẫn`
      );
    });
  }

  private handleAxiosError(error: unknown, fallbackMessage: string): never {
    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError<{ description?: string }>;
      const description = axiosErr.response?.data?.description || axiosErr.message;
      this.logger.warn(`Telegram API error: ${description}`);
      throw new BadRequestException(`${fallbackMessage}: ${description}`);
    }
    throw new BadRequestException(fallbackMessage);
  }
}

