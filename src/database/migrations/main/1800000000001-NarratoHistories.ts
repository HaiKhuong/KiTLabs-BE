import { MigrationInterface, QueryRunner } from "typeorm";

export class NarratoHistories1800000000001 implements MigrationInterface {
  name = "NarratoHistories1800000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing = await queryRunner.query(`SELECT to_regclass('public.narrato_histories') AS t`);
    if (existing[0]?.t) {
      return;
    }
    await queryRunner.query(
      `DO $enum$ BEGIN CREATE TYPE "public"."narrato_histories_status_enum" AS ENUM('pending', 'running', 'completed', 'failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $enum$`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "narrato_histories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "display_name" character varying(255) NOT NULL, "engine_config" jsonb, "script_payload" jsonb, "status" "public"."narrato_histories_status_enum" NOT NULL DEFAULT 'pending', "cost" numeric(12,2) NOT NULL DEFAULT '0', "result_path" character varying, "result_file_name" character varying, "error_message" text, "queue_job_id" character varying, CONSTRAINT "PK_narrato_histories" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `DO $fk$ BEGIN ALTER TABLE "narrato_histories" ADD CONSTRAINT "FK_narrato_histories_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $fk$`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "narrato_histories" DROP CONSTRAINT "FK_narrato_histories_user_id"`);
    await queryRunner.query(`DROP TABLE "narrato_histories"`);
    await queryRunner.query(`DROP TYPE "public"."narrato_histories_status_enum"`);
  }
}
