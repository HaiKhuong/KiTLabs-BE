import { Injectable, Logger } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import { PlatformCredentialsService } from "../platform/credentials/platform-credentials.service";

export interface TelegramSendMessageOptions {
  chatId?: string;
  parseMode?: "HTML" | "Markdown" | "MarkdownV2";
  disableNotification?: boolean;
  disableWebPagePreview?: boolean;
}

export interface DonationSuccessTelegramData {
  donorName: string;
  userCode?: string | null;
  amount: number;
  exp: number;
  transactionCode: string;
  sepayId?: string | number;
  gateway?: string;
  content?: string;
  transactionDate?: string;
}

export interface DonationFailedTelegramData {
  amount?: number;
  error: string;
  status?: string;
  userCode?: string | null;
  sepayId?: string | number;
  transactionCode?: string;
  gateway?: string;
  content?: string;
  transactionDate?: string;
}

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly http: AxiosInstance;
  private readonly numberFormatter = new Intl.NumberFormat("vi-VN");

  constructor(private readonly credentialsService: PlatformCredentialsService) {
    this.http = axios.create({
      baseURL: "https://api.telegram.org",
      timeout: 10_000,
    });
  }

  /**
   * Get configured Telegram Bot Token from platform credentials
   */
  async getBotToken(): Promise<string> {
    return (await this.credentialsService.get("TELEGRAM_BOT_TOKEN")).trim();
  }

  /**
   * Get configured Telegram Chat ID from platform credentials
   */
  async getChatId(): Promise<string> {
    return (await this.credentialsService.get("TELEGRAM_CHAT_ID")).trim();
  }

  /**
   * Send arbitrary message to Telegram chat
   */
  async sendMessage(
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<{ success: boolean; messageId?: number; error?: string }> {
    try {
      const botToken = await this.getBotToken();
      const chatId = options?.chatId || (await this.getChatId());

      if (!botToken || !chatId) {
        this.logger.warn(
          `Telegram not configured (BOT_TOKEN=${botToken ? "CONFIGURED" : "MISSING"}, CHAT_ID=${chatId ? "CONFIGURED" : "MISSING"}), skipping notification`,
        );
        return { success: false, error: "Telegram Bot Token or Chat ID not configured" };
      }

      const postBody: Record<string, any> = {
        chat_id: chatId,
        text,
      };

      if (options?.parseMode) {
        postBody.parse_mode = options.parseMode;
      }
      if (options?.disableNotification) {
        postBody.disable_notification = true;
      }

      let res;
      try {
        res = await this.http.post(`/bot${botToken}/sendMessage`, postBody);
      } catch (postErr: any) {
        // If HTML entity parsing fails, fallback cleanly to plain text (strip tags)
        if (postBody.parse_mode && postErr?.response?.data?.description?.includes("parse entities")) {
          this.logger.warn(
            `Telegram HTML parse error: ${postErr.response.data.description}. Retrying with plain text.`,
          );
          delete postBody.parse_mode;
          postBody.text = text.replace(/<[^>]*>/g, "");
          res = await this.http.post(`/bot${botToken}/sendMessage`, postBody);
        } else {
          throw postErr;
        }
      }

      if (res.data?.ok) {
        return { success: true, messageId: res.data?.result?.message_id };
      }

      this.logger.warn(`Telegram API error: ${JSON.stringify(res.data)}`);
      return { success: false, error: res.data?.description || "Unknown Telegram error" };
    } catch (err: any) {
      const errMsg = err?.response?.data?.description || err?.message || String(err);
      this.logger.error(`Failed to send Telegram message: ${errMsg}`);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Send notification for a successful donation
   */
  async sendDonationSuccessNotification(data: DonationSuccessTelegramData): Promise<boolean> {
    this.logger.log(
      `Dispatching Telegram donation success notification for donor="${data.donorName}", amount=${data.amount}, sepayId=${data.sepayId}`,
    );

    const amountStr = this.numberFormatter.format(data.amount);
    const expStr = this.numberFormatter.format(data.exp);
    const timeStr = data.transactionDate || new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    const html = [
      `💰 <b>GIAO DỊCH DONATE THÀNH CÔNG</b>`,
      ``,
      `👤 <b>Người ủng hộ:</b> ${this.escapeHtml(data.donorName)}${data.userCode ? ` (Mã: <code>${this.escapeHtml(data.userCode)}</code>)` : ""}`,
      `💵 <b>Số tiền:</b> <code>+${amountStr} đ</code>`,
      `✨ <b>EXP nhận:</b> <code>+${expStr} EXP</code>`,
      `🏦 <b>Cổng / Ngân hàng:</b> <code>${this.escapeHtml(data.gateway || "Chuyển khoản QR")}</code>`,
      `📝 <b>Nội dung CK:</b> <code>${this.escapeHtml(data.content || "N/A")}</code>`,
      `🆔 <b>Mã SePay:</b> <code>#${this.escapeHtml(String(data.sepayId || data.transactionCode || "N/A"))}</code>`,
      `⏰ <b>Thời gian:</b> <i>${this.escapeHtml(timeStr)}</i>`,
    ].join("\n");

    const result = await this.sendMessage(html, { parseMode: "HTML" });
    if (result.success) {
      this.logger.log(`Telegram donation success notification sent (messageId=${result.messageId})`);
    } else {
      this.logger.warn(`Telegram donation success notification failed: ${result.error}`);
    }
    return result.success;
  }

  /**
   * Send notification for a failed or unmatched donation
   */
  async sendDonationFailedNotification(data: DonationFailedTelegramData): Promise<boolean> {
    this.logger.log(`Dispatching Telegram donation alert (status=${data.status}): ${data.error}`);

    const amountStr = data.amount != null ? this.numberFormatter.format(data.amount) : "N/A";
    const timeStr = data.transactionDate || new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    const isUnmatched = data.status === "UNMATCHED";

    const html = [
      `🚨 <b>CẢNH BÁO: GIAO DỊCH DONATE XỬ LÝ LỖI</b>`,
      ``,
      `⚠️ <b>Trạng thái:</b> <b>${isUnmatched ? "CHƯA KHỚP NGƯỜI DÙNG (UNMATCHED)" : "XỬ LÝ THẤT BẠI (FAILED)"}</b>`,
      `💵 <b>Số tiền:</b> <code>${amountStr} đ</code>`,
      `🏦 <b>Cổng / Ngân hàng:</b> <code>${this.escapeHtml(data.gateway || "N/A")}</code>`,
      `📝 <b>Nội dung CK:</b> <code>${this.escapeHtml(data.content || "N/A")}</code>`,
      `🆔 <b>Mã SePay:</b> <code>#${this.escapeHtml(String(data.sepayId || data.transactionCode || "N/A"))}</code>`,
      `❌ <b>Chi tiết lỗi:</b> <code>${this.escapeHtml(data.error)}</code>`,
      `⏰ <b>Thời gian:</b> <i>${this.escapeHtml(timeStr)}</i>`,
      ``,
      `👉 <i>Vui lòng vào trang Quản trị SePay để kiểm tra và xử lý lại giao dịch!</i>`,
    ].join("\n");

    const result = await this.sendMessage(html, { parseMode: "HTML" });
    if (result.success) {
      this.logger.log(`Telegram donation alert sent (messageId=${result.messageId})`);
    } else {
      this.logger.warn(`Telegram donation alert failed: ${result.error}`);
    }
    return result.success;
  }

  /**
   * Test sending a sample message to verify bot token & chat ID
   */
  async testConnection(
    customBotToken?: string,
    customChatId?: string,
    customText?: string,
  ): Promise<{ success: boolean; message: string; botInfo?: any }> {
    const token = (customBotToken || (await this.getBotToken())).trim();
    const chatId = (customChatId || (await this.getChatId())).trim();

    if (!token) {
      return { success: false, message: "Chưa cấu hình Telegram Bot Token" };
    }
    if (!chatId) {
      return { success: false, message: "Chưa cấu hình Telegram Chat ID" };
    }

    try {
      // 1. Check bot info
      const meRes = await this.http.get(`/bot${token}/getMe`);
      if (!meRes.data?.ok) {
        return {
          success: false,
          message: `Bot Token không hợp lệ: ${meRes.data?.description || "Lỗi xác thực"}`,
        };
      }

      const botInfo = meRes.data.result;

      // 2. Send test message
      const text =
        customText ||
        `🤖 <b>KIỂM TRA KẾT NỐI TELEGRAM BOT THÀNH CÔNG!</b>\n\n` +
          `• <b>Bot:</b> @${botInfo.username} (${botInfo.first_name})\n` +
          `• <b>Chat ID:</b> <code>${chatId}</code>\n` +
          `• <b>Hệ thống:</b> KiTLabs Platform\n` +
          `• <b>Thời gian:</b> ${new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })}\n\n` +
          `✅ <i>Cấu hình đã sẵn sàng nhận thông báo giao dịch Donate!</i>`;

      const sendRes = await this.http.post(`/bot${token}/sendMessage`, {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
      });

      if (sendRes.data?.ok) {
        return {
          success: true,
          message: `Gửi tin nhắn thử nghiệm thành công tới Chat ID: ${chatId} qua bot @${botInfo.username}!`,
          botInfo,
        };
      }

      return {
        success: false,
        message: sendRes.data?.description || "Không thể gửi tin nhắn thử nghiệm",
        botInfo,
      };
    } catch (err: any) {
      const errMsg = err?.response?.data?.description || err?.message || String(err);
      return { success: false, message: `Lỗi kết nối Telegram: ${errMsg}` };
    }
  }

  private escapeHtml(text: string): string {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
}

