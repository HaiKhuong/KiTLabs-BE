import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import axios, { AxiosError } from "axios";

import { ModuleRef } from "@nestjs/core";
import { AppConfigService } from "../../common/config/app-config.service";
import { TranslateService } from "../translate/translate.service";
import { GoogleSheetsService } from "./google-sheets.service";
import { TelegramGeminiService } from "./telegram-gemini.service";
import { TelegramUserConfigService } from "./telegram-user-config.service";
import {
  TelegramBotInfo,
  TelegramDetectedChat,
  TelegramFile,
  TelegramMessage,
  TelegramUpdate,
} from "./telegram.types";

export type TelegramCommandHandler = (
  message: TelegramMessage,
  bot: TelegramBotInfo,
  args: string,
) => Promise<string | void>;

export interface PhotoBatchItem {
  fileId: string;
  mimeType: string;
  caption?: string;
  messageId: number;
}

export interface PhotoBatch {
  chatId: string;
  userId: string;
  fullName: string;
  username?: string;
  customToken?: string;
  items: PhotoBatchItem[];
  timer: NodeJS.Timeout;
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  private readonly commandHandlers = new Map<string, TelegramCommandHandler>();
  private readonly pendingPhotoBatches = new Map<string, PhotoBatch>();

  // Trạng thái Polling background runner
  private pollingActive = false;
  private pollingAbortController: AbortController | null = null;
  private lastUpdateId = 0;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly userConfigService: TelegramUserConfigService,
    private readonly googleSheetsService: GoogleSheetsService,
    private readonly geminiService: TelegramGeminiService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.registerDefaultCommands();
  }

  async onModuleInit(): Promise<void> {
    const token = this.resolveToken();
    if (token) {
      this.logger.log("Telegram Bot Token phát hiện được, khởi động Background Polling runner...");
      this.startPolling().catch((err) => {
        this.logger.warn(`Lỗi khởi động Telegram polling: ${err?.message || err}`);
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopPolling();
    for (const batch of this.pendingPhotoBatches.values()) {
      clearTimeout(batch.timer);
    }
    this.pendingPhotoBatches.clear();
  }

  /**
   * Lấy Bot Token từ AppConfig hoặc nhận token tạm thời được truyền vào
   */
  resolveToken(customToken?: string): string {
    const raw = (customToken?.trim() || this.appConfig.getSecret("TELEGRAM_BOT_TOKEN")).trim();
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
          timeout: (options.timeout ? options.timeout + 10 : 15) * 1000,
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

      // Xử lý update
      void this.handleIncomingUpdate(update, customToken);
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
   * Tải file từ Telegram qua file_id
   */
  async downloadTelegramFile(
    fileId: string,
    customToken?: string,
  ): Promise<{ buffer: Buffer; fileName?: string; mimeType?: string }> {
    const token = this.resolveToken(customToken);
    if (!token) {
      throw new BadRequestException("Thiếu Bot Token");
    }

    const fileInfoRes = await axios.get<{ ok: boolean; result: TelegramFile }>(
      `https://api.telegram.org/bot${token}/getFile`,
      { params: { file_id: fileId }, timeout: 10_000 },
    );

    const filePath = fileInfoRes.data.result?.file_path;
    if (!filePath) {
      throw new BadRequestException("Không lấy được đường dẫn tệp từ Telegram");
    }

    const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const fileRes = await axios.get<ArrayBuffer>(downloadUrl, {
      responseType: "arraybuffer",
      timeout: 30_000,
    });

    const buffer = Buffer.from(fileRes.data);
    const ext = filePath.split(".").pop()?.toLowerCase() || "";
    let mimeType = "image/jpeg";
    if (ext === "png") mimeType = "image/png";
    if (ext === "webp") mimeType = "image/webp";
    if (ext === "json") mimeType = "application/json";

    return {
      buffer,
      fileName: filePath.split("/").pop(),
      mimeType,
    };
  }

  /**
   * Đăng ký xử lý lệnh
   */
  registerCommandHandler(command: string, handler: TelegramCommandHandler): void {
    const normalized = command.startsWith("/") ? command.slice(1).toLowerCase() : command.toLowerCase();
    this.commandHandlers.set(normalized, handler);
  }

  /**
   * Khởi động Background Long Polling
   */
  async startPolling(customToken?: string): Promise<boolean> {
    if (this.pollingActive) {
      return true;
    }

    const token = this.resolveToken(customToken);
    if (!token) {
      this.logger.warn("Không thể bật Polling: Chưa có Bot Token.");
      return false;
    }

    let bot: TelegramBotInfo;
    try {
      bot = await this.getMe(token);
    } catch (err) {
      this.logger.error(`Không thể xác thực Bot Token khi bật Polling: ${err}`);
      return false;
    }

    this.pollingActive = true;
    this.pollingAbortController = new AbortController();
    this.logger.log(`🤖 Telegram Polling đã kích hoạt cho bot @${bot.username}`);

    void (async () => {
      while (this.pollingActive) {
        try {
          const updates = await this.getUpdates(
            {
              offset: this.lastUpdateId > 0 ? this.lastUpdateId + 1 : undefined,
              limit: 50,
              timeout: 20,
            },
            token,
          );

          for (const update of updates) {
            if (update.update_id >= this.lastUpdateId) {
              this.lastUpdateId = update.update_id;
            }
            await this.handleIncomingUpdate(update, token);
          }
        } catch (pollErr: unknown) {
          if (!this.pollingActive) break;
          const msg = (pollErr as Error)?.message || String(pollErr);
          this.logger.warn(`Telegram polling loop notice: ${msg}`);
          // Chờ 3 giây trước khi retry nếu có lỗi mạng
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
    })();

    return true;
  }

  /**
   * Dừng Polling runner
   */
  stopPolling(): void {
    this.pollingActive = false;
    if (this.pollingAbortController) {
      this.pollingAbortController.abort();
      this.pollingAbortController = null;
    }
    this.logger.log("Telegram Polling runner đã dừng.");
  }

  /**
   * Trạng thái Polling hiện tại
   */
  isPolling(): boolean {
    return this.pollingActive;
  }

  /**
   * Điểm xử lý tập trung mọi update đến từ Webhook hoặc Polling
   */
  async handleIncomingUpdate(update: TelegramUpdate, customToken?: string): Promise<void> {
    const msg = update.message || update.channel_post || update.edited_message;
    if (!msg || !msg.chat) return;

    let bot: TelegramBotInfo;
    try {
      bot = await this.getMe(customToken);
    } catch {
      return;
    }

    // 1. Nếu có hình ảnh đính kèm (photo hoặc document là ảnh)
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
    const isImageDoc =
      msg.document?.mime_type?.startsWith("image/") ||
      Boolean(msg.document?.file_name?.match(/\.(jpe?g|png|webp|bmp)$/i));

    if (hasPhoto || isImageDoc) {
      await this.handleIncomingPhoto(msg, bot, customToken);
      return;
    }

    // 2. Nếu là document chứa file .json (Google Service Account key)
    if (msg.document?.file_name?.endsWith(".json")) {
      await this.handleIncomingJsonDocument(msg, bot, customToken);
      return;
    }

    // 3. Nếu là tin nhắn văn bản thông thường
    if (msg.text) {
      await this.handleIncomingTextMessage(msg, bot, customToken);
    }
  }

  /**
   * Gom nhận ảnh từ Telegram (hỗ trợ gửi nhiều ảnh / Album media_group)
   */
  async handleIncomingPhoto(
    msg: TelegramMessage,
    bot: TelegramBotInfo,
    customToken?: string,
  ): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || msg.chat.id);
    const fullName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ");
    const username = msg.from?.username;

    // 1. Xác định file_id có độ phân giải cao nhất
    let fileId = "";
    let mimeType = "image/jpeg";

    if (Array.isArray(msg.photo) && msg.photo.length > 0) {
      fileId = msg.photo[msg.photo.length - 1].file_id;
    } else if (msg.document?.file_id) {
      fileId = msg.document.file_id;
      mimeType = msg.document.mime_type || "image/jpeg";
    }

    if (!fileId) {
      return;
    }

    // 2. Định danh Batch (album media_group_id hoặc gom ảnh đơn gửi gần nhau trong chat)
    const batchKey = msg.media_group_id
      ? `group_${chatId}_${msg.media_group_id}`
      : `chat_${chatId}`;

    const item: PhotoBatchItem = {
      fileId,
      mimeType,
      caption: msg.caption,
      messageId: msg.message_id,
    };

    const existing = this.pendingPhotoBatches.get(batchKey);
    if (existing) {
      clearTimeout(existing.timer);
      existing.items.push(item);
      // Reset debounce timer chờ thêm ảnh tiếp theo
      existing.timer = setTimeout(() => {
        void this.processPhotoBatch(batchKey);
      }, 1000);
      this.logger.log(
        `[Telegram] Nhận thêm ảnh (${existing.items.length}) cho nhóm ${batchKey} (chat: ${chatId})`,
      );
    } else {
      const timer = setTimeout(() => {
        void this.processPhotoBatch(batchKey);
      }, 1000);
      this.pendingPhotoBatches.set(batchKey, {
        chatId,
        userId,
        fullName,
        username,
        customToken,
        items: [item],
        timer,
      });
      this.logger.log(`[Telegram] Bắt đầu gom ảnh cho nhóm ${batchKey} (chat: ${chatId})...`);
    }
  }

  /**
   * Xử lý trọn gói toàn bộ ảnh đã gom: Tải tất cả ảnh -> 1 request Gemini Vision -> Kết nối & Ghi Google Sheets
   */
  async processPhotoBatch(batchKey: string): Promise<void> {
    const batch = this.pendingPhotoBatches.get(batchKey);
    if (!batch) return;
    this.pendingPhotoBatches.delete(batchKey);

    const { chatId, userId, fullName, username, customToken, items } = batch;
    const totalImages = items.length;

    // Lấy cấu hình của User
    const userConfig = await this.userConfigService.getOrCreate(userId, chatId, {
      fullName,
      username,
    });

    // 1. Kiểm tra cấu hình Spreadsheet ID
    if (!userConfig.spreadsheetId?.trim()) {
      const clientEmail = this.googleSheetsService.getClientEmail(userConfig.googleCredentials);
      const emailNotice = clientEmail
        ? `\n\n📧 *Email Service Account cần cấp quyền Editor:*\n\`${clientEmail}\``
        : "";

      await this.sendMessage(
        chatId,
        `⚠️ *Bạn chưa cài đặt Google Sheet để lưu dữ liệu!*\n\n` +
          `👉 Hãy gửi link Google Sheet của bạn:\n` +
          `\`\`\`\n/sheet https://docs.google.com/spreadsheets/d/.../edit\n\`\`\`\n` +
          `*(Hoặc dán trực tiếp link Google Sheet vào chat này)*${emailNotice}\n\n` +
          `💡 Gõ \`/help\` để xem hướng dẫn chi tiết.`,
        { parse_mode: "Markdown" },
        customToken,
      );
      return;
    }

    // 2. Kiểm tra cấu hình Google Service Account Credentials
    const clientEmail = this.googleSheetsService.getClientEmail(userConfig.googleCredentials);
    if (!clientEmail) {
      await this.sendMessage(
        chatId,
        `⚠️ *Chưa cấu hình Google Service Account!*\n\n` +
          `Bot cần tệp thông tin xác thực JSON để kết nối và ghi dữ liệu vào Google Sheets.\n\n` +
          `👉 *Cách thiết lập:*\n` +
          `• Gửi trực tiếp tệp \`credentials.json\` tải từ Google Cloud Console vào chat này.\n` +
          `• Hoặc dùng lệnh: \`/credentials <dán nội dung json>\`\n\n` +
          `💡 Gõ \`/help\` để xem hướng dẫn chi tiết.`,
        { parse_mode: "Markdown" },
        customToken,
      );
      return;
    }

    // 3. Thông báo đang xử lý
    const statusNotice =
      totalImages > 1
        ? `⏳ *Đang tải ${totalImages} ảnh và phân tích dữ liệu cùng lúc qua Gemini AI...*\nVui lòng chờ trong giây lát.`
        : `⏳ *Đang tải ảnh và phân tích dữ liệu qua Gemini AI...*\nVui lòng chờ trong giây lát.`;

    await this.sendMessage(chatId, statusNotice, { parse_mode: "Markdown" }, customToken);

    try {
      // 3. Tải tất cả các ảnh từ Telegram song song
      this.logger.log(`[Telegram] Bắt đầu tải ${totalImages} ảnh từ Telegram cho chat ${chatId}...`);
      const downloadedImages = await Promise.all(
        items.map(async (it) => {
          const { buffer, mimeType } = await this.downloadTelegramFile(it.fileId, customToken);
          return {
            buffer,
            mimeType: mimeType || it.mimeType,
          };
        }),
      );

      // 4. Tổng hợp caption đính kèm (nếu có)
      const combinedCaption = items
        .map((it) => it.caption?.trim())
        .filter(Boolean)
        .join("\n");

      // 5. Gửi TẤT CẢ các ảnh trong 1 REQUEST DUY NHẤT lên Gemini Vision
      this.logger.log(
        `[Telegram] Gửi ${downloadedImages.length} ảnh trong 1 request lên Gemini AI cho chat ${chatId}...`,
      );
      const extracted = await this.geminiService.extractDataFromImages({
        images: downloadedImages,
        customPrompt: userConfig.geminiPrompt,
        caption: combinedCaption,
        userApiKey: userConfig.geminiApiKey,
      });

      if (!extracted.rows || extracted.rows.length === 0) {
        await this.sendMessage(
          chatId,
          `⚠️ *Không tìm thấy dữ liệu bảng tính trong ${totalImages} ảnh.*\n\n` +
            `Gemini phản hồi:\n_${extracted.rawText.slice(0, 500)}_`,
          { parse_mode: "Markdown" },
          customToken,
        );
        return;
      }

      // 6. Ghi dữ liệu vào Google Sheet (Scope: https://www.googleapis.com/auth/spreadsheets)
      const appendResult = await this.googleSheetsService.appendRows({
        spreadsheetId: userConfig.spreadsheetId,
        sheetName: userConfig.sheetName,
        headers: extracted.headers,
        rows: extracted.rows,
        userCredentials: userConfig.googleCredentials,
      });

      // 7. Tạo bản xem trước dữ liệu gửi lại cho người dùng
      const previewLines = extracted.rows.slice(0, 6).map((row) => `• ${row.join(" | ")}`);
      const moreCount = extracted.rows.length - 6;
      const moreText = moreCount > 0 ? `\n_...và ${moreCount} dòng khác_` : "";

      const summaryText = extracted.summary ? `📌 *Tóm tắt:* ${extracted.summary}\n` : "";
      const imagesBadge = totalImages > 1 ? `🖼️ *Số ảnh đã xử lý cùng lúc:* \`${totalImages}\` ảnh\n` : "";

      const replyText =
        `✅ *Đã ghi dữ liệu vào Google Sheet thành công!*\n\n` +
        imagesBadge +
        `📊 *Bảng tính:* [${appendResult.spreadsheetTitle}](${appendResult.spreadsheetUrl})\n` +
        `📑 *Trang tính (Tab):* \`${appendResult.sheetName}\`\n` +
        `📝 *Số dòng đã thêm:* \`${appendResult.updatedRows}\` dòng\n` +
        summaryText +
        `\n📋 *Bản xem trước dữ liệu:*\n` +
        previewLines.join("\n") +
        moreText +
        `\n\n👉 [Bấm vào đây để mở Google Sheet](${appendResult.spreadsheetUrl})`;

      await this.sendMessage(chatId, replyText, { parse_mode: "Markdown" }, customToken);
    } catch (err: unknown) {
      const errMsg = (err as Error)?.message || String(err);
      this.logger.error(`Error processing photo batch for chat ${chatId}: ${errMsg}`, (err as Error)?.stack);

      const safeError = errMsg.replace(/_/g, "\\_");
      try {
        await this.sendMessage(
          chatId,
          `❌ *Lỗi xử lý ảnh & cập nhật Google Sheet:*\n\n${safeError}`,
          { parse_mode: "Markdown" },
          customToken,
        );
      } catch {
        try {
          await this.sendMessage(
            chatId,
            `❌ Lỗi xử lý ảnh & cập nhật Google Sheet:\n\n${errMsg}`,
            { parse_mode: undefined },
            customToken,
          );
        } catch (sendErr) {
          this.logger.error(`Failed to send error notification to chat ${chatId}: ${sendErr}`);
        }
      }
    }
  }

  /**
   * Tự động nhận diện khi người dùng gửi tệp JSON (Google Service Account key)
   */
  async handleIncomingJsonDocument(
    msg: TelegramMessage,
    bot: TelegramBotInfo,
    customToken?: string,
  ): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || msg.chat.id);
    const fileId = msg.document?.file_id;
    if (!fileId) return;

    try {
      const { buffer } = await this.downloadTelegramFile(fileId, customToken);
      const content = buffer.toString("utf-8");
      const parsed = JSON.parse(content) as Record<string, unknown>;

      if (parsed.client_email && (parsed.private_key || parsed.type === "service_account")) {
        await this.userConfigService.updateConfig(userId, {
          googleCredentials: content,
        });

        await this.sendMessage(
          chatId,
          `✅ *Đã nhận diện & lưu Google Service Account Credentials!*\n\n` +
            `📧 *Email Service Account:* \`${parsed.client_email}\`\n` +
            `📁 *Project ID:* \`${parsed.project_id || "N/A"}\`\n\n` +
            `💡 *Bước quan trọng:* Bạn hãy mở Google Sheet cần lưu, bấm **Chia sẻ (Share)** và thêm email trên với quyền **Người chỉnh sửa (Editor)** nhé!`,
          { parse_mode: "Markdown" },
          customToken,
        );
      }
    } catch {
      // Không phải tệp Service Account JSON hợp lệ, bỏ qua
    }
  }

  /**
   * Xử lý tin nhắn văn bản và các lệnh
   */
  async handleIncomingTextMessage(
    msg: TelegramMessage,
    bot: TelegramBotInfo,
    customToken?: string,
  ): Promise<void> {
    if (!msg.text || !msg.chat) return;
    const text = msg.text.trim();

    // Tự động nhận diện nếu người dùng dán trực tiếp đường link Google Sheet
    if (text.includes("docs.google.com/spreadsheets/d/")) {
      await this.handleDirectSheetLink(msg, text, customToken);
      return;
    }

    const commandPart = text.split(" ")[0].toLowerCase();
    const commandName = commandPart.startsWith("/") ? commandPart.slice(1).split("@")[0] : "";

    const args = text.slice(commandPart.length).trim();

    const handler = this.commandHandlers.get(commandName);
    if (handler) {
      try {
        const reply = await handler(msg, bot, args);
        if (reply && typeof reply === "string") {
          await this.sendMessage(String(msg.chat.id), reply, { parse_mode: "Markdown" }, customToken);
        }
      } catch (err) {
        this.logger.error(`Error handling command /${commandName}:`, err);
        await this.sendMessage(
          String(msg.chat.id),
          `❌ *Có lỗi khi thực thi lệnh /${commandName}:*\n${(err as Error)?.message || err}`,
          { parse_mode: "Markdown" },
          customToken,
        );
      }
    }
  }

  /**
   * Tự động nhận diện khi người dùng paste link Google Sheet trong hội thoại
   */
  private async handleDirectSheetLink(msg: TelegramMessage, text: string, customToken?: string): Promise<void> {
    const chatId = String(msg.chat.id);
    const userId = String(msg.from?.id || msg.chat.id);
    const spreadsheetId = this.googleSheetsService.extractSpreadsheetId(text);

    if (spreadsheetId) {
      const config = await this.userConfigService.getOrCreate(userId, chatId);
      await this.userConfigService.updateConfig(userId, { spreadsheetId });

      const clientEmail = this.googleSheetsService.getClientEmail(config.googleCredentials);
      const emailNotice = clientEmail
        ? `\n\n👉 *Lưu ý:* Hãy nhớ cấp quyền **Editor** cho email:\n\`${clientEmail}\``
        : "";

      await this.sendMessage(
        chatId,
        `📋 *Đã nhận diện và lưu Google Sheet của bạn!*\n\n` +
          `🆔 *Spreadsheet ID:* \`${spreadsheetId}\`\n` +
          `🔗 [Mở bảng tính](https://docs.google.com/spreadsheets/d/${spreadsheetId})${emailNotice}\n\n` +
          `💡 Bây giờ bạn có thể gửi ảnh hóa đơn/chứng từ vào đây để bot tự động trích xuất và điền vào file!`,
        { parse_mode: "Markdown" },
        customToken,
      );
    }
  }

  /**
   * Đăng ký danh sách các lệnh cấu hình
   */
  private registerDefaultCommands(): void {
    // 1. /start: Lời chào và hướng dẫn
    this.registerCommandHandler("start", async (msg, bot) => {
      const name = msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : "bạn";
      const userId = String(msg.from?.id || msg.chat.id);
      const userConfig = await this.userConfigService.getOrCreate(userId, String(msg.chat.id));
      const clientEmail = this.googleSheetsService.getClientEmail(userConfig.googleCredentials);

      return (
        `👋 Chào mừng *${name}* đến với *KiTLabs AI Image to Google Sheets*!\n\n` +
        `🤖 *Tính năng chính:*\n` +
        `Gửi ảnh hóa đơn, chứng từ, bảng kê vào chat -> Gemini Vision trích xuất dữ liệu -> Tự động điền dòng vào Google Sheet online!\n\n` +
        `🚀 *Các bước cài đặt nhanh:*\n` +
        `1️⃣ *Đặt Google Sheet:* Gõ \`/sheet <link>\` hoặc dán link Google Sheet vào đây.\n` +
        `2️⃣ *Cấp quyền Editor:* Bấm **Chia sẻ (Share)** trên Google Sheet cho email:\n` +
        `\`${clientEmail || "Chưa cấu hình Service Account"}\`\n` +
        `3️⃣ *Gửi ảnh:* Gửi bất kỳ ảnh hóa đơn/bảng biểu nào để trải nghiệm!\n\n` +
        `📖 Gõ \`/help\` để xem danh sách toàn bộ các lệnh cấu hình.`
      );
    });

    // 2. /help: Danh sách lệnh
    this.registerCommandHandler("help", async () => {
      return (
        `📖 *DANH SÁCH LỆNH CẤU HÌNH:*\n\n` +
        `📊 *Cấu hình Google Sheet:*\n` +
        `• \`/sheet <link_hoặc_id>\` : Đặt Google Sheet lưu kết quả\n` +
        `• \`/tab <tên_tab>\` : Đặt tab/trang tính (Ví dụ: \`/tab ChiPhi\`)\n` +
        `• \`/test_sheet\` : Kiểm tra kết nối & quyền Editor trên Google Sheet\n\n` +
        `🤖 *Cấu hình Gemini AI:*\n` +
        `• \`/prompt <nội dung>\` : Đặt yêu cầu trích xuất dữ liệu riêng\n` +
        `• \`/prompt reset\` : Trở về prompt mặc định của hệ thống\n` +
        `• \`/gemini_key <api_key>\` : Đặt Gemini API Key cá nhân của bạn\n\n` +
        `🔑 *Cấu hình Tài khoản Google:*\n` +
        `• Gửi trực tiếp file \`credentials.json\` của Service Account vào chat này\n` +
        `• Hoặc dùng: \`/credentials <nội dung json>\`\n\n` +
        `⚙️ *Quản lý & Trạng thái:*\n` +
        `• \`/config\` hoặc \`/status\` : Xem chi tiết cấu hình hiện tại của bạn\n` +
        `• \`/reset\` : Xóa cấu hình cá nhân về mặc định\n` +
        `• \`/chatid\` hoặc \`/id\` : Lấy Chat ID phòng này`
      );
    });

    // 3. /sheet hoặc /set_sheet: Đặt Google Sheet
    const handleSetSheet: TelegramCommandHandler = async (msg, bot, args) => {
      if (!args) {
        return (
          `⚠️ *Cú pháp không đúng.*\n` +
          `Vui lòng nhập: \`/sheet <link hoặc ID Google Sheet>\`\n\n` +
          `Ví dụ:\n\`/sheet https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit\``
        );
      }

      const spreadsheetId = this.googleSheetsService.extractSpreadsheetId(args);
      const userId = String(msg.from?.id || msg.chat.id);
      await this.userConfigService.getOrCreate(userId, String(msg.chat.id));
      const updated = await this.userConfigService.updateConfig(userId, { spreadsheetId });

      const clientEmail = this.googleSheetsService.getClientEmail(updated.googleCredentials);
      const emailNotice = clientEmail
        ? `\n\n👉 *Nhắc nhở:* Đừng quên chia sẻ (Share) quyền **Editor** cho email:\n\`${clientEmail}\``
        : "";

      return (
        `✅ *Đã lưu Google Sheet thành công!*\n\n` +
        `🆔 *Spreadsheet ID:* \`${spreadsheetId}\`\n` +
        `🔗 [Mở bảng tính](https://docs.google.com/spreadsheets/d/${spreadsheetId})${emailNotice}\n\n` +
        `Gõ \`/test_sheet\` để kiểm tra quyền truy cập!`
      );
    };
    this.registerCommandHandler("sheet", handleSetSheet);
    this.registerCommandHandler("set_sheet", handleSetSheet);

    // 4. /tab hoặc /set_tab: Đặt tên trang tính
    const handleSetTab: TelegramCommandHandler = async (msg, bot, args) => {
      if (!args) {
        return `⚠️ Vui lòng nhập tên tab: \`/tab <tên_tab>\`\nVí dụ: \`/tab Sheet1\` hoặc \`/tab Hóa đơn\``;
      }
      const userId = String(msg.from?.id || msg.chat.id);
      await this.userConfigService.getOrCreate(userId, String(msg.chat.id));
      await this.userConfigService.updateConfig(userId, { sheetName: args.trim() });

      return `✅ *Đã đặt tên tab trang tính thành:* \`${args.trim()}\``;
    };
    this.registerCommandHandler("tab", handleSetTab);
    this.registerCommandHandler("set_tab", handleSetTab);

    // 5. /prompt hoặc /set_prompt: Đặt Prompt trích xuất
    const handleSetPrompt: TelegramCommandHandler = async (msg, bot, args) => {
      const userId = String(msg.from?.id || msg.chat.id);
      await this.userConfigService.getOrCreate(userId, String(msg.chat.id));

      if (!args || args.toLowerCase() === "reset") {
        await this.userConfigService.updateConfig(userId, { geminiPrompt: undefined });
        return `🔄 *Đã đặt lại Prompt Gemini về mặc định của hệ thống!*`;
      }

      await this.userConfigService.updateConfig(userId, { geminiPrompt: args });
      return (
        `✅ *Đã lưu Prompt Gemini tùy chỉnh của bạn:*\n\n` +
        `_${args}_\n\n` +
        `💡 Khi bạn gửi ảnh, Gemini sẽ ưu tiên làm theo hướng dẫn này!`
      );
    };
    this.registerCommandHandler("prompt", handleSetPrompt);
    this.registerCommandHandler("set_prompt", handleSetPrompt);

    // 6. /gemini_key: Cài đặt & đồng bộ Gemini API key chung cho toàn hệ thống
    this.registerCommandHandler("gemini_key", async (msg, bot, args) => {
      const userId = String(msg.from?.id || msg.chat.id);
      const userConf = await this.userConfigService.getOrCreate(userId, String(msg.chat.id));

      if (!args) {
        let currentKey = "";
        try {
          currentKey = this.geminiService.resolveApiKey(userConf?.geminiApiKey);
        } catch {}
        if (currentKey) {
          const masked = currentKey.length > 10 ? `${currentKey.slice(0, 6)}...${currentKey.slice(-4)}` : "******";
          return (
            `ℹ️ *Trạng thái Gemini API Key:*\n\n` +
            `Bot đang sử dụng key: \`${masked}\`\n\n` +
            `👉 Để đổi key dùng chung cho toàn hệ thống: \`/gemini_key <API_KEY>\`\n` +
            `👉 Để xóa key cá nhân: \`/gemini_key reset\``
          );
        }
        return (
          `⚠️ *Chưa cấu hình Gemini API Key!*\n\n` +
          `👉 Vui lòng cấu hình bằng lệnh: \`/gemini_key <API_KEY_CỦA_BẠN>\`\n` +
          `hoặc cấu hình tại menu *Cấu hình Runtime* trên ứng dụng KiTLabs.`
        );
      }

      if (args.toLowerCase() === "reset") {
        await this.userConfigService.updateConfig(userId, { geminiApiKey: undefined });
        return `🔄 *Đã đặt lại Gemini API key về key chung mặc định của hệ thống.*`;
      }

      const key = args.trim();
      await this.userConfigService.updateConfig(userId, { geminiApiKey: key });

      // Đồng bộ trực tiếp vào Vault cấu hình Runtime của toàn hệ thống
      try {
        await this.appConfig.upsertRuntime("GEMINI_API_KEY", key);
        this.logger.log(`[Telegram] Đã đồng bộ Gemini API Key vào hệ thống từ chat ${msg.chat.id}`);
      } catch (e: any) {
        this.logger.warn(`Could not sync GEMINI_API_KEY to system: ${e?.message || e}`);
      }

      const masked = key.length > 10 ? `${key.slice(0, 6)}...${key.slice(-4)}` : "******";
      return (
        `✅ *Đã lưu và đồng bộ Gemini API Key cho toàn hệ thống!*\n\n` +
        `🔑 *Key:* \`${masked}\`\n\n` +
        `🌐 *Phạm vi áp dụng:* Tất cả các tính năng AI (Thuyết minh video, OCR Google Sheets, Veo, Recap...) sẽ dùng chung key này!`
      );
    });

    // 7. /credentials: Cài đặt Service Account JSON
    this.registerCommandHandler("credentials", async (msg, bot, args) => {
      const userId = String(msg.from?.id || msg.chat.id);
      await this.userConfigService.getOrCreate(userId, String(msg.chat.id));

      if (!args) {
        return (
          `ℹ️ *Cách cấu hình Google Service Account:*\n\n` +
          `Cách 1: Gửi trực tiếp file \`credentials.json\` tải từ Google Cloud Console vào chat này.\n\n` +
          `Cách 2: Gõ \`/credentials <dán toàn bộ chuỗi json>\`\n\n` +
          `Nếu muốn xóa và dùng credentials hệ thống: \`/credentials reset\``
        );
      }

      if (args.toLowerCase() === "reset") {
        await this.userConfigService.updateConfig(userId, { googleCredentials: undefined });
        return `🔄 *Đã đặt lại Credentials về mặc định hệ thống.*`;
      }

      try {
        const parsed = JSON.parse(args) as Record<string, unknown>;
        if (!parsed.client_email || !parsed.private_key) {
          return `❌ Chuỗi JSON không hợp lệ (thiếu \`client_email\` hoặc \`private_key\`).`;
        }

        await this.userConfigService.updateConfig(userId, { googleCredentials: args });
        return (
          `✅ *Đã lưu Google Service Account Credentials!*\n` +
          `📧 Email: \`${parsed.client_email}\``
        );
      } catch {
        return `❌ Nội dung không phải là chuỗi JSON hợp lệ.`;
      }
    });

    // 8. /test_sheet: Kiểm tra kết nối tới Google Sheet
    this.registerCommandHandler("test_sheet", async (msg) => {
      const userId = String(msg.from?.id || msg.chat.id);
      const userConfig = await this.userConfigService.findByTelegramUserId(userId);

      if (!userConfig?.spreadsheetId) {
        return `⚠️ Bạn chưa cấu hình Google Sheet. Dùng \`/sheet <link>\` để đặt trước.`;
      }

      try {
        const result = await this.googleSheetsService.verifyConnection(
          userConfig.spreadsheetId,
          userConfig.googleCredentials,
        );

        return (
          `✅ *Kết nối Google Sheet thành công!*\n\n` +
          `📊 *Tiêu đề:* ${result.title}\n` +
          `🆔 *ID:* \`${result.spreadsheetId}\`\n` +
          `📑 *Danh sách các Tab:* ${result.sheetNames.map((s) => `\`${s}\``).join(", ")}\n` +
          `📧 *Service Account:* \`${result.clientEmail}\`\n\n` +
          `🎉 Bot đã có đầy đủ quyền thao tác trên file này!`
        );
      } catch (err) {
        return (err as Error)?.message || String(err);
      }
    });

    // 9. /config hoặc /status: Xem cấu hình hiện tại
    const handleConfig: TelegramCommandHandler = async (msg) => {
      const userId = String(msg.from?.id || msg.chat.id);
      const config = await this.userConfigService.getOrCreate(userId, String(msg.chat.id));
      const clientEmail = this.googleSheetsService.getClientEmail(config.googleCredentials);

      const sheetDisplay = config.spreadsheetId
        ? `[Mở bảng tính](https://docs.google.com/spreadsheets/d/${config.spreadsheetId}) (\`${config.spreadsheetId}\`)`
        : "_Chưa cấu hình_";

      const promptDisplay = config.geminiPrompt
        ? `_${config.geminiPrompt.slice(0, 100)}${config.geminiPrompt.length > 100 ? "..." : ""}_`
        : "_Mặc định hệ thống_";

      let systemKeyConfigured = false;
      try {
        const testKey = this.geminiService.resolveApiKey(config.geminiApiKey || undefined);
        systemKeyConfigured = Boolean(testKey);
      } catch {
        systemKeyConfigured = false;
      }
      const geminiKeyDisplay = config.geminiApiKey
        ? "🔑 _Key riêng cá nhân (Đã kết nối)_"
        : systemKeyConfigured
          ? "🌐 _Dùng chung key hệ thống KiTLabs (Sẵn sàng)_"
          : "⚠️ _Chưa cấu hình (Gõ /gemini_key để cài)_";

      const authDisplay = config.googleCredentials
        ? `🔑 _Service Account riêng: \`${clientEmail}\`_`
        : clientEmail
          ? `🌐 _Service Account hệ thống: \`${clientEmail}\`_`
          : "⚠️ _Chưa cấu hình_";

      return (
        `⚙️ *CẤU HÌNH HIỆN TẠI CỦA BẠN:*\n\n` +
        `👤 *Telegram ID:* \`${userId}\`\n` +
        `📊 *Google Sheet:* ${sheetDisplay}\n` +
        `📑 *Tên Tab:* \`${config.sheetName}\`\n` +
        `🔐 *Google Auth:* ${authDisplay}\n` +
        `🤖 *Gemini Key:* ${geminiKeyDisplay}\n` +
        `📝 *Prompt:* ${promptDisplay}\n\n` +
        `💡 Dùng \`/help\` để xem cách thay đổi các mục trên.`
      );
    };
    this.registerCommandHandler("config", handleConfig);
    this.registerCommandHandler("status", handleConfig);

    // 10. /reset: Reset cấu hình về mặc định
    this.registerCommandHandler("reset", async (msg) => {
      const userId = String(msg.from?.id || msg.chat.id);
      await this.userConfigService.resetConfig(userId);
      return `🔄 *Cấu hình của bạn đã được xóa về mặc định thành công!*`;
    });

    // 11. /chatid hoặc /id: Lấy Chat ID
    const respondId: TelegramCommandHandler = async (msg) => {
      const name = msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : "bạn";
      return (
        `👋 Chào *${name}*!\n\n` +
        `🆔 *Chat ID của bạn:* \`${msg.chat.id}\`\n` +
        `📋 *Loại phòng:* \`${msg.chat.type}\`\n\n` +
        `💡 Bạn hãy sao chép dãy số ID trên nếu cần cấu hình thông báo hệ thống.`
      );
    };

    // 12. /auto_vs_retry: Thử lại tiến trình thuyết minh phim bị lỗi
    this.registerCommandHandler("auto_vs_retry", async (msg, bot, args) => {
      const chatId = String(msg.chat.id);
      const movieName = (args || "").trim();
      if (!movieName) {
        return (
          `⚠️ *Cú pháp không đúng.*\n` +
          `Vui lòng nhập: \`/auto_vs_retry <tên phim>\`\n\n` +
          `*Ví dụ:*\n` +
          `• \`/auto_vs_retry tap_01\`\n` +
          `• \`/auto_vs_retry tap_01.mp4\``
        );
      }

      const translateService = this.getTranslateService();
      if (!translateService) {
        return `❌ *Lỗi hệ thống:* Không thể kết nối tới dịch vụ Translate lúc này.`;
      }

      const result = await translateService.retryByMovieName(movieName, chatId);
      if (!result.success) {
        return `❌ *Lỗi:* ${result.message}`;
      }

      return `🔄 Đã tiếp nhận và bắt đầu thử lại cho phim: *${(result.movieFileName || movieName).replace(/_/g, "\\_")}*`;
    });

    this.registerCommandHandler("chatid", respondId);
    this.registerCommandHandler("id", respondId);
  }


  private getTranslateService(): TranslateService | null {
    try {
      return this.moduleRef.get(TranslateService, { strict: false });
    } catch {
      return null;
    }
  }

  getDefaultChatId(): string {
    return (this.appConfig.get("TELEGRAM_CHAT_ID") || process.env.TELEGRAM_CHAT_ID || "").trim();
  }

  classifyPipelineError(rawError: string | undefined): string {
    if (!rawError) {
      return "Lỗi Hệ Thống ( Các lỗi khác )";
    }
    const lower = rawError.toLowerCase();
    if (
      lower.includes("[step_1_failed]") ||
      lower.includes("step1") ||
      lower.includes("step 1") ||
      lower.includes("transcribe") ||
      lower.includes("whisper") ||
      lower.includes("paddleocr") ||
      lower.includes("easyocr") ||
      lower.includes("vse")
    ) {
      return "Lỗi Dịch ( Step 1 lỗi )";
    }
    if (
      lower.includes("[step_2_failed]") ||
      lower.includes("step2") ||
      lower.includes("step 2") ||
      lower.includes("gemini") ||
      lower.includes("translate_srt")
    ) {
      return "Lỗi Gemini ( step 2 lỗi )";
    }
    return "Lỗi Hệ Thống ( Các lỗi khác )";
  }

  async sendPipelineNotification(
    type: "completed" | "retrying" | "failed",
    params: {
      movieName: string;
      duration?: string;
      errorMessage?: string;
      chatId?: string;
    },
  ): Promise<boolean> {
    const targetChatId = (params.chatId || this.getDefaultChatId()).trim();
    if (!targetChatId) {
      this.logger.warn(`Không tìm thấy Telegram Chat ID để gửi thông báo pipeline (${type})`);
      return false;
    }

    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
    const safeMovieName = params.movieName.replace(/_/g, "\\_");

    if (type === "retrying") {
      // Đã tắt gửi thông báo "THUYẾT MINH PHIM ĐANG THỬ LẠI!"
      return false;
    }

    let text = "";
    if (type === "completed") {
      text =
        `✨ *THUYẾT MINH PHIM HOÀN TẤT!* ✨\n\n` +
        `🎬 *Tên phim:* ${safeMovieName}\n` +
        `⏱ *Thời lượng:* ${params.duration || "N/A"}\n` +
        `🕒 *Thời gian:* ${timeStr}`;
    } else if (type === "failed") {
      const errorMsg = this.classifyPipelineError(params.errorMessage);
      text =
        `❌ *THUYẾT MINH PHIM THẤT BẠI!*\n\n` +
        `🎬 *Tên phim:* ${safeMovieName}\n` +
        `💬 *Chi tiết lỗi:* ${errorMsg}\n` +
        `🕒 *Thời gian:* ${timeStr}\n\n` +
        `👉 Dùng \`/auto_vs_retry ${params.movieName}\` để thử lại`;
    }

    try {
      return await this.sendMessage(targetChatId, text, { parse_mode: "Markdown" });
    } catch (err: any) {
      this.logger.warn(`Lỗi gửi thông báo Telegram pipeline: ${err?.message || err}`);
      return false;
    }
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
