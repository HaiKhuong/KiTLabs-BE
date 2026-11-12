import { MigrationInterface, QueryRunner } from "typeorm";

export class AddFacebookPlaylistsAndVideos1800000000013 implements MigrationInterface {
  name = "AddFacebookPlaylistsAndVideos1800000000013";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "facebook_playlists" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "page_id" uuid NOT NULL,
        "facebook_playlist_id" varchar(128) NOT NULL,
        "title" varchar(500) NOT NULL,
        "description" text,
        "video_count" integer DEFAULT 0,
        "synced_at" timestamptz DEFAULT CURRENT_TIMESTAMP,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_facebook_playlists_page_fb_id" ON "facebook_playlists" ("page_id", "facebook_playlist_id");

      CREATE TABLE IF NOT EXISTS "facebook_videos" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "page_id" uuid NOT NULL,
        "playlist_id" uuid,
        "playlist_title" varchar(500),
        "facebook_video_id" varchar(128) NOT NULL,
        "title" varchar(1000) NOT NULL,
        "description" text,
        "permalink" varchar(2000) NOT NULL,
        "picture_url" text,
        "length" numeric(10,2),
        "published_at" timestamptz,
        "season_label" varchar(100),
        "comment_results" jsonb DEFAULT '[]'::jsonb,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_facebook_videos_page_fb_id" ON "facebook_videos" ("page_id", "facebook_video_id");
      CREATE INDEX IF NOT EXISTS "IDX_facebook_videos_page_playlist" ON "facebook_videos" ("page_id", "playlist_id");

      CREATE TABLE IF NOT EXISTS "facebook_page_comment_settings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "page_id" uuid NOT NULL,
        "selection_rule" varchar(16) DEFAULT 'random',
        "sequential_cursor" integer DEFAULT 0,
        "affiliate_templates" jsonb DEFAULT '[]'::jsonb,
        "movie_playlist_templates" jsonb DEFAULT '[]'::jsonb,
        "cross_promo_templates" jsonb DEFAULT '[]'::jsonb,
        "created_at" timestamptz DEFAULT CURRENT_TIMESTAMP,
        "updated_at" timestamptz DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_facebook_page_comment_settings_user_page" ON "facebook_page_comment_settings" ("user_id", "page_id");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "facebook_page_comment_settings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "facebook_videos"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "facebook_playlists"`);
  }
}

