import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserSettingProfiles1762000000000 implements MigrationInterface {
  name = "AddUserSettingProfiles1762000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_setting_profiles" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "type" character varying(100) NOT NULL,
        "name" character varying(100) NOT NULL,
        "is_default" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_user_setting_profiles_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_setting_profiles_user_type_name" UNIQUE ("user_id", "type", "name")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "user_setting_profiles"
      ADD CONSTRAINT "FK_user_setting_profiles_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    await queryRunner.query(`ALTER TABLE "user_settings" ADD COLUMN IF NOT EXISTS "profile_id" uuid`);

    await queryRunner.query(`
      INSERT INTO "user_setting_profiles" ("user_id", "type", "name", "is_default")
      SELECT DISTINCT "user_id", "type", 'Default', true
      FROM "user_settings"
      ON CONFLICT ("user_id", "type", "name") DO NOTHING
    `);

    await queryRunner.query(`
      UPDATE "user_settings" us
      SET "profile_id" = usp."id"
      FROM "user_setting_profiles" usp
      WHERE usp."user_id" = us."user_id"
        AND usp."type" = us."type"
        AND usp."is_default" = true
    `);

    await queryRunner.query(`ALTER TABLE "user_settings" ALTER COLUMN "profile_id" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT IF EXISTS "UQ_user_settings_user_type_code"`);
    await queryRunner.query(`
      ALTER TABLE "user_settings"
      ADD CONSTRAINT "UQ_user_settings_profile_type_code" UNIQUE ("profile_id", "type", "code")
    `);
    await queryRunner.query(`
      ALTER TABLE "user_settings"
      ADD CONSTRAINT "FK_user_settings_profile_id"
      FOREIGN KEY ("profile_id") REFERENCES "user_setting_profiles"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_user_settings_profile_id" ON "user_settings" ("profile_id")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_user_setting_profiles_user_type" ON "user_setting_profiles" ("user_id", "type")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_setting_profiles_user_type"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_user_settings_profile_id"`);
    await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT IF EXISTS "FK_user_settings_profile_id"`);
    await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT IF EXISTS "UQ_user_settings_profile_type_code"`);
    await queryRunner.query(`
      ALTER TABLE "user_settings"
      ADD CONSTRAINT "UQ_user_settings_user_type_code" UNIQUE ("user_id", "type", "code")
    `);
    await queryRunner.query(`ALTER TABLE "user_settings" DROP COLUMN IF EXISTS "profile_id"`);
    await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP CONSTRAINT IF EXISTS "FK_user_setting_profiles_user_id"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_setting_profiles"`);
  }
}
