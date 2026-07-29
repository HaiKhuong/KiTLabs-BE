import { MigrationInterface, QueryRunner } from "typeorm";

export class AddGeminiImageHistoryMetadata1791000000000 implements MigrationInterface {
  name = "AddGeminiImageHistoryMetadata1791000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        ADD COLUMN "provider" character varying(32) NOT NULL DEFAULT 'comfyui',
        ADD COLUMN "interaction_id" character varying(255),
        ADD COLUMN "image_size" character varying(16),
        ADD COLUMN "api_key_tier" character varying(16),
        ADD COLUMN "use_google_search" boolean NOT NULL DEFAULT false,
        ADD COLUMN "result_mime_type" character varying(128)
    `);
    await queryRunner.query(`
      UPDATE "image_histories"
      SET "result_mime_type" = 'image/png'
      WHERE "result_file_name" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_image_histories_provider_created_at"
      ON "image_histories" ("provider", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_image_histories_provider_created_at"`);
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        DROP COLUMN "result_mime_type",
        DROP COLUMN "use_google_search",
        DROP COLUMN "api_key_tier",
        DROP COLUMN "image_size",
        DROP COLUMN "interaction_id",
        DROP COLUMN "provider"
    `);
  }
}
