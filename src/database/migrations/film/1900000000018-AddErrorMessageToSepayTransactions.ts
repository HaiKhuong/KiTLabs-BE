import { MigrationInterface, QueryRunner } from "typeorm";

export class AddErrorMessageToSepayTransactions1900000000018 implements MigrationInterface {
  name = "AddErrorMessageToSepayTransactions1900000000018";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sepay_transactions"
      ADD COLUMN IF NOT EXISTS "error_message" text;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "sepay_transactions"
      DROP COLUMN IF EXISTS "error_message";
    `);
  }
}

