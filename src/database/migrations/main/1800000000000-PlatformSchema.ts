import { MigrationInterface, QueryRunner } from "typeorm";

export class PlatformSchema1800000000000 implements MigrationInterface {
  name = "PlatformSchema1800000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // 1. Platform Users
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "auth_type" character varying(32) NOT NULL DEFAULT 'account',
        "user_name" character varying(100),
        "email" character varying(150),
        "role" character varying(32) NOT NULL DEFAULT 'USER',
        "password_hash" character varying(255),
        "refresh_token_hash" character varying(255),
        "credit" numeric(12,2) NOT NULL DEFAULT 0,
        "device_id" character varying(255),
        "ip" character varying(64),
        "mac" character varying(64),
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_users" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_user_name" UNIQUE ("user_name"),
        CONSTRAINT "UQ_users_email" UNIQUE ("email")
      )
    `);

    // 2. Platform Credentials
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_credentials" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "provider" character varying(32) NOT NULL,
        "code" character varying(64) NOT NULL,
        "value" text NOT NULL,
        "is_secret" boolean NOT NULL DEFAULT false,
        "description" character varying(255),
        CONSTRAINT "PK_platform_credentials" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_platform_credentials_provider_code" UNIQUE ("provider", "code")
      )
    `);

    // 3. Platform Accounts (OAuth connected accounts)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_accounts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "provider" character varying(32) NOT NULL,
        "account_id" character varying(128) NOT NULL,
        "union_id" character varying(128),
        "username" character varying(150),
        "display_name" character varying(200),
        "avatar_url" text,
        "access_token_encrypted" text,
        "refresh_token_encrypted" text,
        "token_expires_at" TIMESTAMP WITH TIME ZONE,
        "refresh_expires_at" TIMESTAMP WITH TIME ZONE,
        "scopes" text[] DEFAULT '{}',
        "status" character varying(32) NOT NULL DEFAULT 'connected',
        "is_active" boolean NOT NULL DEFAULT true,
        "metadata" jsonb,
        "last_checked_at" TIMESTAMP WITH TIME ZONE,
        "last_check_message" text,
        CONSTRAINT "PK_platform_accounts" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_platform_account_user_provider_account" UNIQUE ("user_id", "provider", "account_id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_accounts_user_provider" ON "platform_accounts" ("user_id", "provider")
    `);

    // 4. Platform Facebook Pages
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_facebook_pages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "account_id" uuid NOT NULL,
        "page_id" character varying(64) NOT NULL,
        "name" character varying(200) NOT NULL,
        "picture_url" text,
        "page_access_token_encrypted" text,
        "tasks" text[] DEFAULT '{}',
        "can_publish" boolean NOT NULL DEFAULT false,
        "can_comment" boolean NOT NULL DEFAULT false,
        "status" character varying(32) NOT NULL DEFAULT 'active',
        "last_checked_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_platform_facebook_pages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_platform_facebook_pages_acc_page" UNIQUE ("account_id", "page_id"),
        CONSTRAINT "FK_platform_facebook_pages_account" FOREIGN KEY ("account_id") REFERENCES "platform_accounts"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_platform_facebook_pages_account" ON "platform_facebook_pages" ("account_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_facebook_pages" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_accounts" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_credentials" CASCADE`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users" CASCADE`);
  }
}
