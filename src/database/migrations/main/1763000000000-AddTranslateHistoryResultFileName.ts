import { MigrationInterface, QueryRunner } from "typeorm";

export class AddTranslateHistoryResultFileName1763000000000 implements MigrationInterface {
  name = "AddTranslateHistoryResultFileName1763000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "translate_histories"
      ADD COLUMN IF NOT EXISTS "result_file_name" character varying
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "translate_histories"
      DROP COLUMN IF EXISTS "result_file_name"
    `);
  }
}
