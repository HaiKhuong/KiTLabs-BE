import { MigrationInterface, QueryRunner } from "typeorm";

export class AddExtraAnalyticsDashboardFields1900000000017 implements MigrationInterface {
  name = "AddExtraAnalyticsDashboardFields1900000000017";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reports_daily_content" 
      ADD COLUMN IF NOT EXISTS "top_favorited_movies" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "top_commenters" jsonb NOT NULL DEFAULT '[]',
      ADD COLUMN IF NOT EXISTS "top_sharers" jsonb NOT NULL DEFAULT '[]';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "reports_daily_content"
      DROP COLUMN IF EXISTS "top_favorited_movies",
      DROP COLUMN IF EXISTS "top_commenters",
      DROP COLUMN IF EXISTS "top_sharers";
    `);
  }
}

