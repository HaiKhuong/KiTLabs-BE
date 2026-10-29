import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThumbnailUrlToMovies1900000000004 implements MigrationInterface {
  name = "AddThumbnailUrlToMovies1900000000004";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "movies"
      ADD COLUMN IF NOT EXISTS "thumbnail_url" character varying;
    `);

    await queryRunner.query(`
      UPDATE "movies"
      SET "thumbnail_url" = "banner_url"
      WHERE "thumbnail_url" IS NULL AND "banner_url" IS NOT NULL;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "movies"
      DROP COLUMN IF EXISTS "thumbnail_url";
    `);
  }
}

