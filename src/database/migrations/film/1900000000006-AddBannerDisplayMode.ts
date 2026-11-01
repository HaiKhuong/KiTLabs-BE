import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBannerDisplayMode1900000000006 implements MigrationInterface {
  name = "AddBannerDisplayMode1900000000006";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."banners_display_mode_enum" AS ENUM('ALWAYS', 'ONCE', 'SESSION');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await queryRunner.query(`
      ALTER TABLE "banners"
      ADD COLUMN IF NOT EXISTS "display_mode" "public"."banners_display_mode_enum" NOT NULL DEFAULT 'ALWAYS';
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "banners" DROP COLUMN IF EXISTS "display_mode";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."banners_display_mode_enum";`);
  }
}
