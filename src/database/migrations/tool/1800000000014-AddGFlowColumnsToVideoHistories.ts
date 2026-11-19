import { MigrationInterface, QueryRunner } from "typeorm";

export class AddGFlowColumnsToVideoHistories1800000000014 implements MigrationInterface {
  name = "AddGFlowColumnsToVideoHistories1800000000014";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "video_histories"
        ADD COLUMN IF NOT EXISTS "provider" varchar(32) NOT NULL DEFAULT 'veo-api',
        ADD COLUMN IF NOT EXISTS "result_path" varchar,
        ADD COLUMN IF NOT EXISTS "result_file_name" varchar,
        ADD COLUMN IF NOT EXISTS "gflow_profile" varchar(64);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "video_histories"
        DROP COLUMN IF EXISTS "gflow_profile",
        DROP COLUMN IF EXISTS "result_file_name",
        DROP COLUMN IF EXISTS "result_path",
        DROP COLUMN IF EXISTS "provider";
    `);
  }
}
