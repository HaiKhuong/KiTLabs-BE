import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTelegramUserConfigs1800000000011 implements MigrationInterface {
  name = "CreateTelegramUserConfigs1800000000011";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
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

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_telegram_user_configs_user_id" ON "telegram_user_configs" ("telegram_user_id");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS "telegram_user_configs";
    `);
  }
}

