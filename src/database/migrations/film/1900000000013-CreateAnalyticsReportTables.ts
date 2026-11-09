import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAnalyticsReportTables1900000000013 implements MigrationInterface {
  name = "CreateAnalyticsReportTables1900000000013";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports_daily_traffic" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "date_key" character varying(10) NOT NULL,
        "total_page_views" integer NOT NULL DEFAULT 0,
        "total_sessions" integer NOT NULL DEFAULT 0,
        "action_sessions" integer NOT NULL DEFAULT 0,
        "action_rate" numeric(5,2) NOT NULL DEFAULT 0,
        "hourly_stats" jsonb NOT NULL DEFAULT '[]',
        "actions_breakdown" jsonb NOT NULL DEFAULT '{}',
        "top_pages" jsonb NOT NULL DEFAULT '[]',
        "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports_daily_traffic_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_traffic_date_key" ON "reports_daily_traffic" ("date_key");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports_daily_users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "date_key" character varying(10) NOT NULL,
        "new_users_count" integer NOT NULL DEFAULT 0,
        "hourly_new_users" jsonb NOT NULL DEFAULT '[]',
        "total_users" integer NOT NULL DEFAULT 0,
        "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports_daily_users_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_users_date_key" ON "reports_daily_users" ("date_key");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports_daily_exp_leaderboard" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "date_key" character varying(10) NOT NULL,
        "rank" integer NOT NULL,
        "user_id" uuid NOT NULL,
        "user_name" character varying(150) NOT NULL,
        "username" character varying(100),
        "avatar_url" text,
        "sect_rank" character varying(50) NOT NULL DEFAULT 'LUYEN_KHI',
        "current_title" character varying(150),
        "total_exp_today" integer NOT NULL DEFAULT 0,
        "earliest_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "latest_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "tx_count" integer NOT NULL DEFAULT 1,
        "exp_sources" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports_daily_exp_leaderboard_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_exp_leaderboard_date_rank" ON "reports_daily_exp_leaderboard" ("date_key", "rank");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_reports_daily_exp_leaderboard_user_id" ON "reports_daily_exp_leaderboard" ("user_id");
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reports_daily_content" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "date_key" character varying(10) NOT NULL,
        "top_watched_movies" jsonb NOT NULL DEFAULT '[]',
        "pending_reports" integer NOT NULL DEFAULT 0,
        "pending_comments" integer NOT NULL DEFAULT 0,
        "last_scanned_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_reports_daily_content_id" PRIMARY KEY ("id")
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_reports_daily_content_date_key" ON "reports_daily_content" ("date_key");
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "reports_daily_content"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reports_daily_exp_leaderboard"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reports_daily_users"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reports_daily_traffic"`);
  }
}

