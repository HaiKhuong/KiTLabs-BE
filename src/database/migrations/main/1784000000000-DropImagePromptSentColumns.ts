import { MigrationInterface, QueryRunner } from "typeorm";

export class DropImagePromptSentColumns1784000000000 implements MigrationInterface {
  name = "DropImagePromptSentColumns1784000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        DROP COLUMN IF EXISTS "prompt_sent",
        DROP COLUMN IF EXISTS "negative_sent"
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "image_histories"
        ADD COLUMN "prompt_sent" text,
        ADD COLUMN "negative_sent" text
    `);
  }
}
