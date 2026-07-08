import { MigrationInterface, QueryRunner } from "typeorm";

export class AddImageGeminiAnalysis1783000000000 implements MigrationInterface {
  name = "AddImageGeminiAnalysis1783000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        ADD COLUMN "prompt_sent" text,
        ADD COLUMN "negative_sent" text,
        ADD COLUMN "enriched_prompt" text,
        ADD COLUMN "gemini_analysis" jsonb
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        DROP COLUMN IF EXISTS "gemini_analysis",
        DROP COLUMN IF EXISTS "enriched_prompt",
        DROP COLUMN IF EXISTS "negative_sent",
        DROP COLUMN IF EXISTS "prompt_sent"
    `);
  }
}
