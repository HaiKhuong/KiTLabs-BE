import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFacebookFilmSync1800000000012 implements MigrationInterface {
  name = "AddFacebookFilmSync1800000000012";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_sync_enabled" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_movie_id" uuid`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_episode_number" numeric(6,1)`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_sync_status" varchar(16)`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_sync_error" text`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_episode_id" uuid`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_source_id" uuid`);
    await queryRunner.query(`ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "film_synced_at" timestamptz`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of ["film_synced_at", "film_source_id", "film_episode_id", "film_sync_error", "film_sync_status", "film_episode_number", "film_movie_id", "film_sync_enabled"]) {
      await queryRunner.query(`ALTER TABLE "facebook_posts" DROP COLUMN IF EXISTS "${column}"`);
    }
  }
}
