import { MigrationInterface, QueryRunner } from "typeorm";

const HISTORY_TABLES = [
  "translate_histories",
  "audio_histories",
  "short_video_histories",
  "whiteboard_histories",
  "recap_histories",
  "narrato_histories",
] as const;

export class AddHistoryDeletedAt1800000000003 implements MigrationInterface {
  name = "AddHistoryDeletedAt1800000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of HISTORY_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of HISTORY_TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "deleted_at"`);
    }
  }
}
