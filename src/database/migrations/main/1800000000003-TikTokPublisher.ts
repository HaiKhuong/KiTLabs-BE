import { MigrationInterface, QueryRunner } from "typeorm";

export class TikTokPublisher1800000000003 implements MigrationInterface {
  name = "TikTokPublisher1800000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."tiktok_accounts_status_enum" AS ENUM ('connected','expired','revoked')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tiktok_videos_status_enum" AS ENUM ('imported','queued','uploading','processing','published','failed','cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tiktok_videos_commercial_disclosure_enum" AS ENUM ('NONE','ORGANIC_BRAND','BRANDED_CONTENT','BOTH')`,
    );
    await queryRunner.query(`
      CREATE TABLE "tiktok_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "open_id" character varying(128) NOT NULL,
        "union_id" character varying(128),
        "username" character varying(150),
        "display_name" character varying(150),
        "avatar_url" text,
        "access_token_encrypted" text NOT NULL,
        "refresh_token_encrypted" text NOT NULL,
        "access_token_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "refresh_token_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "scopes" text array NOT NULL DEFAULT '{}',
        "status" "public"."tiktok_accounts_status_enum" NOT NULL DEFAULT 'connected',
        "is_active" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_tiktok_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_tiktok_accounts_user_open" UNIQUE ("user_id","open_id"),
        CONSTRAINT "FK_tiktok_accounts_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "tiktok_videos" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "account_id" uuid,
        "local_path" text NOT NULL,
        "original_file_name" character varying(255) NOT NULL,
        "file_size" bigint NOT NULL,
        "metadata" jsonb NOT NULL,
        "status" "public"."tiktok_videos_status_enum" NOT NULL DEFAULT 'imported',
        "caption" character varying(2200),
        "privacy_level" character varying(64),
        "commercial_disclosure" "public"."tiktok_videos_commercial_disclosure_enum" NOT NULL DEFAULT 'NONE',
        "is_aigc" boolean NOT NULL DEFAULT false,
        "disable_comment" boolean NOT NULL DEFAULT true,
        "disable_duet" boolean NOT NULL DEFAULT true,
        "disable_stitch" boolean NOT NULL DEFAULT true,
        "publish_id" character varying(255),
        "provider_post_id" character varying(255),
        "uploaded_bytes" bigint NOT NULL DEFAULT 0,
        "queue_job_id" character varying(255),
        "error_code" character varying(100),
        "error_message" text,
        "published_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_tiktok_videos" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tiktok_videos_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_tiktok_videos_account" FOREIGN KEY ("account_id") REFERENCES "tiktok_accounts"("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_tiktok_accounts_user" ON "tiktok_accounts" ("user_id")`);
    await queryRunner.query(
      `CREATE INDEX "IDX_tiktok_videos_user_created" ON "tiktok_videos" ("user_id","created_at")`,
    );
    await queryRunner.query(`CREATE INDEX "IDX_tiktok_videos_account" ON "tiktok_videos" ("account_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "tiktok_videos"`);
    await queryRunner.query(`DROP TABLE "tiktok_accounts"`);
    await queryRunner.query(`DROP TYPE "public"."tiktok_videos_commercial_disclosure_enum"`);
    await queryRunner.query(`DROP TYPE "public"."tiktok_videos_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."tiktok_accounts_status_enum"`);
  }
}
