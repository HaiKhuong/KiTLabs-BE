import { MigrationInterface, QueryRunner } from "typeorm";

export class AddYouTubeContentManager1776000000000 implements MigrationInterface {
  name = "AddYouTubeContentManager1776000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."movies_status_enum" AS ENUM('pending', 'in_progress', 'completed', 'published', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."movies_priority_enum" AS ENUM('low', 'medium', 'high', 'urgent')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."recommendations_priority_enum" AS ENUM('low', 'medium', 'high', 'critical')`,
    );

    await queryRunner.query(`
      CREATE TABLE "youtube_channels" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "channel_id" character varying(50) NOT NULL,
        "name" character varying(255) NOT NULL,
        "thumbnail" text,
        "subscriber_count" integer NOT NULL DEFAULT 0,
        "video_count" integer NOT NULL DEFAULT 0,
        "view_count" bigint NOT NULL DEFAULT 0,
        "google_access_token" text,
        "google_refresh_token" text,
        "token_expires_at" TIMESTAMP WITH TIME ZONE,
        "is_active" boolean NOT NULL DEFAULT true,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_youtube_channels_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_youtube_channels_channel_id" UNIQUE ("channel_id"),
        CONSTRAINT "FK_youtube_channels_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "youtube_videos" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "video_id" character varying(50) NOT NULL,
        "title" character varying(500) NOT NULL,
        "thumbnail" text,
        "description" text,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "views" bigint NOT NULL DEFAULT 0,
        "likes" integer NOT NULL DEFAULT 0,
        "comments" integer NOT NULL DEFAULT 0,
        "ctr" numeric(5,2) NOT NULL DEFAULT 0,
        "watch_time_hours" numeric(10,2) NOT NULL DEFAULT 0,
        "avg_view_duration" integer NOT NULL DEFAULT 0,
        "impressions" bigint NOT NULL DEFAULT 0,
        "score" numeric(5,2),
        "channel_id" uuid NOT NULL,
        CONSTRAINT "PK_youtube_videos_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_youtube_videos_video_id" UNIQUE ("video_id"),
        CONSTRAINT "FK_youtube_videos_channel" FOREIGN KEY ("channel_id") REFERENCES "youtube_channels"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "movies" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "chinese_name" character varying(500) NOT NULL,
        "vietnamese_name" character varying(500),
        "status" "public"."movies_status_enum" NOT NULL DEFAULT 'pending',
        "source" character varying(255),
        "episodes" integer NOT NULL DEFAULT 1,
        "current_episode" integer NOT NULL DEFAULT 0,
        "priority" "public"."movies_priority_enum" NOT NULL DEFAULT 'medium',
        "tags" text,
        "notes" text,
        "score" numeric(5,2) NOT NULL DEFAULT 0,
        "trend_score" numeric(5,2) NOT NULL DEFAULT 0,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_movies_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_movies_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "movie_trends" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "date" date NOT NULL,
        "trend_score" integer NOT NULL DEFAULT 0,
        "search_volume" integer NOT NULL DEFAULT 0,
        "region" character varying(10) NOT NULL DEFAULT 'VN',
        "keyword" character varying(500),
        "related_queries" jsonb,
        "movie_id" uuid NOT NULL,
        CONSTRAINT "PK_movie_trends_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_movie_trends_movie" FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "analytics_snapshots" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "date" date NOT NULL,
        "views" bigint NOT NULL DEFAULT 0,
        "subscribers" integer NOT NULL DEFAULT 0,
        "subscribers_gained" integer NOT NULL DEFAULT 0,
        "subscribers_lost" integer NOT NULL DEFAULT 0,
        "watch_time_hours" numeric(10,2) NOT NULL DEFAULT 0,
        "ctr" numeric(5,2) NOT NULL DEFAULT 0,
        "impressions" bigint NOT NULL DEFAULT 0,
        "avg_view_duration" integer NOT NULL DEFAULT 0,
        "revenue" numeric(10,2) NOT NULL DEFAULT 0,
        "likes" integer NOT NULL DEFAULT 0,
        "comments" integer NOT NULL DEFAULT 0,
        "shares" integer NOT NULL DEFAULT 0,
        "channel_id" uuid NOT NULL,
        CONSTRAINT "PK_analytics_snapshots_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_analytics_snapshots_channel" FOREIGN KEY ("channel_id") REFERENCES "youtube_channels"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "recommendations" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "score" numeric(5,2) NOT NULL,
        "priority" "public"."recommendations_priority_enum" NOT NULL DEFAULT 'medium',
        "reason" text NOT NULL,
        "risk" text,
        "expected_views" character varying(100),
        "expected_ctr" character varying(50),
        "generated_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "batch_id" character varying(50),
        "movie_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        CONSTRAINT "PK_recommendations_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_recommendations_movie" FOREIGN KEY ("movie_id") REFERENCES "movies"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_recommendations_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "ai_chat_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "title" character varying(500),
        "messages" jsonb NOT NULL DEFAULT '[]',
        "user_id" uuid NOT NULL,
        "is_archived" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_ai_chat_histories_id" PRIMARY KEY ("id"),
        CONSTRAINT "FK_ai_chat_histories_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_youtube_channels_user" ON "youtube_channels" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_youtube_videos_channel" ON "youtube_videos" ("channel_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_movies_user" ON "movies" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_movies_status" ON "movies" ("status")`);
    await queryRunner.query(`CREATE INDEX "IDX_movie_trends_movie" ON "movie_trends" ("movie_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_movie_trends_date" ON "movie_trends" ("date")`);
    await queryRunner.query(`CREATE INDEX "IDX_analytics_snapshots_channel" ON "analytics_snapshots" ("channel_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_analytics_snapshots_date" ON "analytics_snapshots" ("date")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendations_movie" ON "recommendations" ("movie_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendations_user" ON "recommendations" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_recommendations_active" ON "recommendations" ("is_active")`);
    await queryRunner.query(`CREATE INDEX "IDX_ai_chat_histories_user" ON "ai_chat_histories" ("user_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "ai_chat_histories"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "recommendations"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "analytics_snapshots"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "movie_trends"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "movies"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "youtube_videos"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "youtube_channels"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."recommendations_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."movies_priority_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."movies_status_enum"`);
  }
}
