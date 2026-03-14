import { MigrationInterface, QueryRunner } from "typeorm";

export class InitMainSchema1760000000000 implements MigrationInterface {
  name = "InitMainSchema1760000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(
      `CREATE TYPE "public"."translate_histories_status_enum" AS ENUM('pending', 'running', 'completed', 'failed')`,
    );
    await queryRunner.query(`CREATE TYPE "public"."download_histories_source_type_enum" AS ENUM('link', 'file')`);
    await queryRunner.query(
      `CREATE TYPE "public"."notifications_type_enum" AS ENUM('info', 'success', 'warning', 'error')`,
    );

    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_name" character varying(100) NOT NULL,
        "password_hash" character varying(255) NOT NULL,
        "refresh_token_hash" character varying(255),
        "credit" numeric(12,2) NOT NULL DEFAULT '0',
        "device_id" character varying(255),
        "ip" character varying(64),
        "mac" character varying(64),
        "is_active" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_users_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_users_user_name" UNIQUE ("user_name")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "credit_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "amount" numeric(12,2) NOT NULL,
        "balance" numeric(12,2) NOT NULL,
        "reason" character varying(255) NOT NULL,
        "metadata" jsonb,
        CONSTRAINT "PK_credit_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_action_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid,
        "action" character varying(100) NOT NULL,
        "payload" jsonb,
        "ip" character varying(64),
        "userAgent" character varying(255),
        CONSTRAINT "PK_user_action_logs_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "translate_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "function_used" text[] NOT NULL DEFAULT '{}',
        "step_nbr" integer[] NOT NULL DEFAULT '{}',
        "engine_config" jsonb,
        "status" "public"."translate_histories_status_enum" NOT NULL DEFAULT 'pending',
        "cost" numeric(12,2) NOT NULL DEFAULT '0',
        "result_path" character varying,
        "error_message" text,
        "queue_job_id" character varying,
        CONSTRAINT "PK_translate_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "download_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "source_type" "public"."download_histories_source_type_enum" NOT NULL,
        "source_value" text NOT NULL,
        "saved_path" character varying,
        "status" character varying(30) NOT NULL DEFAULT 'queued',
        "message" text,
        CONSTRAINT "PK_download_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "type" "public"."notifications_type_enum" NOT NULL DEFAULT 'info',
        "title" character varying(255) NOT NULL,
        "message" text NOT NULL,
        "is_read" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_notifications_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "type" character varying(100) NOT NULL,
        "code" character varying(100) NOT NULL,
        "value" text NOT NULL,
        CONSTRAINT "PK_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_settings_type_code" UNIQUE ("type", "code")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "user_settings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "type" character varying(100) NOT NULL,
        "code" character varying(100) NOT NULL,
        "value" text NOT NULL,
        CONSTRAINT "PK_user_settings_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_user_settings_user_type_code" UNIQUE ("user_id", "type", "code")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "credit_histories"
      ADD CONSTRAINT "FK_credit_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "user_action_logs"
      ADD CONSTRAINT "FK_user_action_logs_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "translate_histories"
      ADD CONSTRAINT "FK_translate_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "download_histories"
      ADD CONSTRAINT "FK_download_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "notifications"
      ADD CONSTRAINT "FK_notifications_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "user_settings"
      ADD CONSTRAINT "FK_user_settings_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "FK_user_settings_user_id"`);
    await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_user_id"`);
    await queryRunner.query(`ALTER TABLE "download_histories" DROP CONSTRAINT "FK_download_histories_user_id"`);
    await queryRunner.query(`ALTER TABLE "translate_histories" DROP CONSTRAINT "FK_translate_histories_user_id"`);
    await queryRunner.query(`ALTER TABLE "user_action_logs" DROP CONSTRAINT "FK_user_action_logs_user_id"`);
    await queryRunner.query(`ALTER TABLE "credit_histories" DROP CONSTRAINT "FK_credit_histories_user_id"`);

    await queryRunner.query(`DROP TABLE "user_settings"`);
    await queryRunner.query(`DROP TABLE "settings"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TABLE "download_histories"`);
    await queryRunner.query(`DROP TABLE "translate_histories"`);
    await queryRunner.query(`DROP TABLE "user_action_logs"`);
    await queryRunner.query(`DROP TABLE "credit_histories"`);
    await queryRunner.query(`DROP TABLE "users"`);

    await queryRunner.query(`DROP TYPE "public"."notifications_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."download_histories_source_type_enum"`);
    await queryRunner.query(`DROP TYPE "public"."translate_histories_status_enum"`);
  }
}
