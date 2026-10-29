import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUploadHistoryReportsSettings1900000000003 implements MigrationInterface {
  name = "AddUploadHistoryReportsSettings1900000000003";

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum for report status
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'movie_reports_status_enum') THEN
          CREATE TYPE "movie_reports_status_enum" AS ENUM('PENDING', 'IN_REVIEW', 'RESOLVED', 'DISMISSED');
        END IF;
      END
      $$;
    `);

    // 2. Table: image_upload_histories
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "image_upload_histories" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "admin_id" uuid,
        "admin_name" character varying(150),
        "admin_email" character varying(150),
        "filename" character varying(255) NOT NULL,
        "original_name" character varying(255),
        "url" text NOT NULL,
        "mime_type" character varying(100),
        "size_bytes" bigint DEFAULT 0 NOT NULL,
        "category" character varying(50) DEFAULT 'general' NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_image_upload_histories_admin_id" ON "image_upload_histories" ("admin_id");
      CREATE INDEX IF NOT EXISTS "IDX_image_upload_histories_created_at" ON "image_upload_histories" ("created_at");
    `);

    // 3. Table: movie_reports
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "movie_reports" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "user_id" uuid,
        "device_id" character varying(150),
        "movie_id" uuid NOT NULL,
        "movie_title" character varying(255),
        "episode_id" uuid,
        "episode_number" numeric(6, 1),
        "episode_title" character varying(255),
        "page_url" text,
        "reason" character varying(100) DEFAULT 'VIDEO_ISSUE' NOT NULL,
        "description" text,
        "status" "movie_reports_status_enum" DEFAULT 'PENDING' NOT NULL,
        "ip_address" character varying(64),
        "user_agent" text,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "resolved_by" uuid
      );
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_movie_id" ON "movie_reports" ("movie_id");
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_episode_id" ON "movie_reports" ("episode_id");
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_user_id" ON "movie_reports" ("user_id");
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_device_id" ON "movie_reports" ("device_id");
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_status" ON "movie_reports" ("status");
      CREATE INDEX IF NOT EXISTS "IDX_movie_reports_created_at" ON "movie_reports" ("created_at");
    `);

    // 4. Table: settings
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "settings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "key" character varying(150) NOT NULL UNIQUE,
        "value" jsonb NOT NULL,
        "description" character varying(255),
        "is_public" boolean DEFAULT true NOT NULL
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_settings_key" ON "settings" ("key");
    `);

    // Seed initial default settings if empty
    await queryRunner.query(`
      INSERT INTO "settings" ("key", "value", "description", "is_public")
      VALUES
        ('SITE_INFO', '{"name": "KiTLabs Film", "slogan": "Thế Giới Phim Hoạt Hình & Anime Đỉnh Cao", "hotline": "1900-xxxx", "contact_email": "contact@kitlabs.space"}'::jsonb, 'Thông tin chung website', true),
        ('PLAYER_CONFIG', '{"autoplay": true, "default_quality": "1080P", "watermark": true, "countdown_seconds": 5}'::jsonb, 'Cấu hình trình phát video', true),
        ('MAINTENANCE_MODE', '{"enabled": false, "message": "Hệ thống đang bảo trì định kỳ, vui lòng quay lại sau ít phút."}'::jsonb, 'Chế độ bảo trì hệ thống', true)
      ON CONFLICT ("key") DO NOTHING;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "settings";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "movie_reports";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "image_upload_histories";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "movie_reports_status_enum";`);
  }
}

