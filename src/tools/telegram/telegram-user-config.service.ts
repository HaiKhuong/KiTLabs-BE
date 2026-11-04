import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { TelegramUserConfig } from "./telegram-user-config.entity";

@Injectable()
export class TelegramUserConfigService implements OnModuleInit {
  private readonly logger = new Logger(TelegramUserConfigService.name);

  constructor(
    @InjectRepository(TelegramUserConfig, "tool")
    private readonly repo: Repository<TelegramUserConfig>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureTable();
  }

  /**
   * Đảm bảo bảng tồn tại ngay cả khi chưa chạy migration
   */
  private async ensureTable(): Promise<void> {
    try {
      await this.repo.query(`
        CREATE TABLE IF NOT EXISTS "telegram_user_configs" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "created_at" TIMESTAMP NOT NULL DEFAULT now(),
          "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
          "telegram_user_id" character varying(100) NOT NULL,
          "chat_id" character varying(100) NOT NULL,
          "username" character varying(100),
          "full_name" character varying(255),
          "spreadsheet_id" character varying(255),
          "sheet_name" character varying(100) NOT NULL DEFAULT 'Sheet1',
          "gemini_prompt" text,
          "gemini_api_key" character varying(255),
          "google_credentials" text,
          "write_mode" character varying(50) NOT NULL DEFAULT 'append',
          "last_active_at" TIMESTAMP,
          CONSTRAINT "PK_telegram_user_configs_id" PRIMARY KEY ("id"),
          CONSTRAINT "UQ_telegram_user_configs_user_id" UNIQUE ("telegram_user_id")
        );
      `);
      await this.repo.query(`
        CREATE INDEX IF NOT EXISTS "IDX_telegram_user_configs_user_id" ON "telegram_user_configs" ("telegram_user_id");
      `);
    } catch (err) {
      this.logger.warn(`Could not verify telegram_user_configs table (will rely on migration): ${err}`);
    }
  }

  /**
   * Lấy cấu hình của user theo telegramUserId hoặc tạo mới nếu chưa có
   */
  async getOrCreate(
    telegramUserId: string,
    chatId: string,
    meta?: { username?: string; fullName?: string },
  ): Promise<TelegramUserConfig> {
    let config = await this.repo.findOne({ where: { telegramUserId } });

    if (!config) {
      config = this.repo.create({
        telegramUserId,
        chatId,
        username: meta?.username,
        fullName: meta?.fullName,
        sheetName: "Sheet1",
        writeMode: "append",
        lastActiveAt: new Date(),
      });
      return this.repo.save(config);
    }

    let changed = false;
    if (chatId && config.chatId !== chatId) {
      config.chatId = chatId;
      changed = true;
    }
    if (meta?.username && config.username !== meta.username) {
      config.username = meta.username;
      changed = true;
    }
    if (meta?.fullName && config.fullName !== meta.fullName) {
      config.fullName = meta.fullName;
      changed = true;
    }
    config.lastActiveAt = new Date();

    if (changed) {
      return this.repo.save(config);
    }
    return config;
  }

  /**
   * Cập nhật từng trường cấu hình cho user
   */
  async updateConfig(
    telegramUserId: string,
    partial: Partial<TelegramUserConfig>,
  ): Promise<TelegramUserConfig> {
    const config = await this.repo.findOne({ where: { telegramUserId } });
    if (!config) {
      throw new Error(`Chưa tìm thấy cấu hình cho Telegram User ID: ${telegramUserId}`);
    }

    Object.assign(config, partial);
    config.lastActiveAt = new Date();
    return this.repo.save(config);
  }

  /**
   * Reset cấu hình của user về mặc định
   */
  async resetConfig(telegramUserId: string): Promise<TelegramUserConfig> {
    const config = await this.repo.findOne({ where: { telegramUserId } });
    if (!config) {
      throw new Error(`Chưa tìm thấy cấu hình cho Telegram User ID: ${telegramUserId}`);
    }

    config.spreadsheetId = undefined;
    config.sheetName = "Sheet1";
    config.geminiPrompt = undefined;
    config.geminiApiKey = undefined;
    config.googleCredentials = undefined;
    config.writeMode = "append";
    config.lastActiveAt = new Date();

    return this.repo.save(config);
  }

  /**
   * Danh sách tất cả cấu hình của người dùng (dành cho Admin / API)
   */
  async findAll(): Promise<TelegramUserConfig[]> {
    return this.repo.find({ order: { updatedAt: "DESC" } });
  }

  /**
   * Tìm theo ID
   */
  async findByTelegramUserId(telegramUserId: string): Promise<TelegramUserConfig | null> {
    return this.repo.findOne({ where: { telegramUserId } });
  }
}

