import { Column, Entity, Index } from "typeorm";
import { BaseEntity } from "../../common/entities/base.entity";

@Entity("telegram_user_configs")
export class TelegramUserConfig extends BaseEntity {
  @Index({ unique: true })
  @Column({ name: "telegram_user_id", length: 100 })
  telegramUserId!: string;

  @Column({ name: "chat_id", length: 100 })
  chatId!: string;

  @Column({ name: "username", length: 100, nullable: true })
  username?: string;

  @Column({ name: "full_name", length: 255, nullable: true })
  fullName?: string;

  @Column({ name: "spreadsheet_id", length: 255, nullable: true })
  spreadsheetId?: string;

  @Column({ name: "sheet_name", length: 100, default: "Sheet1" })
  sheetName!: string;

  @Column({ name: "gemini_prompt", type: "text", nullable: true })
  geminiPrompt?: string;

  @Column({ name: "gemini_api_key", length: 255, nullable: true })
  geminiApiKey?: string;

  @Column({ name: "google_credentials", type: "text", nullable: true })
  googleCredentials?: string;

  @Column({ name: "write_mode", length: 50, default: "append" })
  writeMode!: string;

  @Column({ name: "last_active_at", type: "timestamp", nullable: true })
  lastActiveAt?: Date;
}

