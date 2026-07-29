import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserSettingProfileIsEnabled1789000000000 implements MigrationInterface {
  name = "AddUserSettingProfileIsEnabled1789000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "user_setting_profiles"
      ADD COLUMN IF NOT EXISTS "is_enabled" boolean NOT NULL DEFAULT true
    `);

    await queryRunner.query(`
      ALTER TABLE "user_setting_profiles"
      ADD COLUMN IF NOT EXISTS "disabled_at" TIMESTAMP
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_setting_profiles_user_type_enabled"
      ON "user_setting_profiles" ("user_id", "type", "is_enabled")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_setting_profiles_user_type_enabled"`);
    await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP COLUMN IF EXISTS "disabled_at"`);
    await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP COLUMN IF EXISTS "is_enabled"`);
  }
}
