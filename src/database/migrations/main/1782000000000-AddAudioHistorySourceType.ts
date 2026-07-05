import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAudioHistorySourceType1782000000000 implements MigrationInterface {
  name = "AddAudioHistorySourceType1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      ADD COLUMN "source_type" character varying(16)
    `);

    await queryRunner.query(`
      UPDATE "audio_histories"
      SET "source_type" = 'auto'
      WHERE "engine_config"->>'source' = 'video_voice'
    `);

    await queryRunner.query(`
      UPDATE "audio_histories"
      SET "source_type" = 'studio'
      WHERE "source_type" IS NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      ALTER COLUMN "source_type" SET NOT NULL
    `);

    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      ALTER COLUMN "source_type" SET DEFAULT 'studio'
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_audio_histories_user_source_created"
      ON "audio_histories" ("user_id", "source_type", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_audio_histories_user_source_created"`);
    await queryRunner.query(`ALTER TABLE "audio_histories" DROP COLUMN "source_type"`);
  }
}
