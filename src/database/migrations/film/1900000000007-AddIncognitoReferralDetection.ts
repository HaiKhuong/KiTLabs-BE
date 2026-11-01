import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIncognitoReferralDetection1900000000007 implements MigrationInterface {
  name = "AddIncognitoReferralDetection1900000000007";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "is_incognito" boolean`,
    );
    await queryRunner.query(
      `ALTER TABLE "devices" ADD COLUMN IF NOT EXISTS "incognito_browser" varchar(100)`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_referrals" ADD COLUMN IF NOT EXISTS "is_reward_eligible" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_referrals" ADD COLUMN IF NOT EXISTS "rejection_reason" varchar(50)`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_referrals" DROP COLUMN IF EXISTS "rejection_reason"`);
    await queryRunner.query(
      `ALTER TABLE "user_referrals" DROP COLUMN IF EXISTS "is_reward_eligible"`,
    );
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "incognito_browser"`);
    await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN IF EXISTS "is_incognito"`);
  }
}
