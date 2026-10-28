import { MigrationInterface, QueryRunner } from "typeorm";

export class UseBannerUrlForMovies1900000000002 implements MigrationInterface {
  name = "UseBannerUrlForMovies1900000000002";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'movies'
            AND column_name = 'poster_url'
        ) THEN
          EXECUTE 'UPDATE "movies"
                   SET "banner_url" = "poster_url"
                   WHERE "banner_url" IS NULL
                     AND "poster_url" IS NOT NULL';
          EXECUTE 'ALTER TABLE "movies" DROP COLUMN "poster_url"';
        END IF;
      END
      $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "movies"
      ADD COLUMN IF NOT EXISTS "poster_url" character varying
    `);
    await queryRunner.query(`
      UPDATE "movies"
      SET "poster_url" = "banner_url"
      WHERE "poster_url" IS NULL
    `);
  }
}
