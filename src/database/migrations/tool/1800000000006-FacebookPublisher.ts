import { MigrationInterface, QueryRunner } from "typeorm";

export class FacebookPublisher1800000000006 implements MigrationInterface {
  name = "FacebookPublisher1800000000006";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "facebook_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "fb_user_id" character varying(64) NOT NULL,
        "name" character varying(200),
        "picture_url" text,
        "access_token_encrypted" text,
        "token_expires_at" TIMESTAMP WITH TIME ZONE,
        "scopes" text array NOT NULL DEFAULT '{}',
        "status" character varying(32) NOT NULL DEFAULT 'connected',
        "last_checked_at" TIMESTAMP WITH TIME ZONE,
        "last_check_message" text,
        CONSTRAINT "PK_facebook_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_facebook_accounts_user" UNIQUE ("user_id"),
        CONSTRAINT "FK_facebook_accounts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "facebook_pages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "account_id" uuid NOT NULL,
        "page_id" character varying(64) NOT NULL,
        "name" character varying(200) NOT NULL,
        "picture_url" text,
        "page_access_token_encrypted" text,
        "tasks" text array NOT NULL DEFAULT '{}',
        "can_publish" boolean NOT NULL DEFAULT false,
        "can_comment" boolean NOT NULL DEFAULT false,
        "status" character varying(32) NOT NULL DEFAULT 'active',
        "last_checked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_facebook_pages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_facebook_pages_account_page" UNIQUE ("account_id","page_id"),
        CONSTRAINT "FK_facebook_pages_account" FOREIGN KEY ("account_id") REFERENCES "facebook_accounts"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "facebook_posts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "page_id" uuid,
        "kind" character varying(16) NOT NULL,
        "title" character varying(255),
        "message" text,
        "local_path" text,
        "original_file_name" character varying(255),
        "file_size" bigint,
        "status" character varying(32) NOT NULL DEFAULT 'draft',
        "scheduled_at" TIMESTAMP WITH TIME ZONE,
        "published_at" TIMESTAMP WITH TIME ZONE,
        "facebook_post_id" character varying(128),
        "upload_phase" character varying(16) NOT NULL DEFAULT 'none',
        "upload_session_id" character varying(255),
        "upload_offset" bigint NOT NULL DEFAULT 0,
        "affiliate_enabled" boolean NOT NULL DEFAULT true,
        "source_post_id" uuid,
        "comment_results" jsonb NOT NULL DEFAULT '[]',
        "queue_job_id" character varying(255),
        "error_code" character varying(100),
        "error_message" text,
        CONSTRAINT "PK_facebook_posts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_facebook_posts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_facebook_posts_page" FOREIGN KEY ("page_id") REFERENCES "facebook_pages"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "facebook_affiliate_links" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "name" character varying(200) NOT NULL,
        "affiliate_url" text NOT NULL,
        "destination_url" text,
        "product_group" character varying(120) NOT NULL DEFAULT '',
        "keywords" text array NOT NULL DEFAULT '{}',
        "page_ids" text array NOT NULL DEFAULT '{}',
        "status" character varying(16) NOT NULL DEFAULT 'active',
        "starts_at" TIMESTAMP WITH TIME ZONE,
        "ends_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_facebook_affiliate_links" PRIMARY KEY ("id"),
        CONSTRAINT "FK_facebook_affiliate_links_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "facebook_comment_settings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "auto_comment_video" boolean NOT NULL DEFAULT false,
        "auto_comment_post" boolean NOT NULL DEFAULT false,
        "comment_count" integer NOT NULL DEFAULT 1,
        "selection_rule" character varying(16) NOT NULL DEFAULT 'random',
        "sequential_cursor" integer NOT NULL DEFAULT 0,
        "templates" jsonb NOT NULL DEFAULT '[]',
        CONSTRAINT "PK_facebook_comment_settings" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_facebook_comment_settings_user" UNIQUE ("user_id"),
        CONSTRAINT "FK_facebook_comment_settings_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "facebook_task_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "post_id" uuid,
        "page_id" uuid,
        "kind" character varying(32) NOT NULL,
        "attempt" integer NOT NULL DEFAULT 1,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "facebook_object_id" character varying(128),
        "phase_before" character varying(16),
        "error_code" character varying(100),
        "error_message" text,
        "http_status" integer,
        "retryable" boolean NOT NULL DEFAULT false,
        "outcome" character varying(32) NOT NULL,
        CONSTRAINT "PK_facebook_task_logs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_facebook_task_logs_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_facebook_task_logs_post" FOREIGN KEY ("post_id") REFERENCES "facebook_posts"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_facebook_posts_user_created" ON "facebook_posts" ("user_id","created_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_facebook_posts_status_scheduled" ON "facebook_posts" ("status","scheduled_at")`);
    await queryRunner.query(`CREATE INDEX "IDX_facebook_affiliate_links_user" ON "facebook_affiliate_links" ("user_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_facebook_task_logs_user_created" ON "facebook_task_logs" ("user_id","created_at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "facebook_task_logs"`);
    await queryRunner.query(`DROP TABLE "facebook_comment_settings"`);
    await queryRunner.query(`DROP TABLE "facebook_affiliate_links"`);
    await queryRunner.query(`DROP TABLE "facebook_posts"`);
    await queryRunner.query(`DROP TABLE "facebook_pages"`);
    await queryRunner.query(`DROP TABLE "facebook_accounts"`);
  }
}
