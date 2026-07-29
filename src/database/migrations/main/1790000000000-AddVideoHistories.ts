import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVideoHistories1790000000000 implements MigrationInterface {
  name = "AddVideoHistories1790000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "public"."video_histories_status_enum"
      AS ENUM ('pending', 'running', 'completed', 'failed')
    `);
    await queryRunner.query(`
      CREATE TABLE "video_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "prompt" text NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "model" character varying(128) NOT NULL,
        "aspect_ratio" character varying(16) NOT NULL,
        "duration_seconds" integer NOT NULL,
        "resolution" character varying(16) NOT NULL,
        "person_generation" character varying(32),
        "seed" bigint,
        "api_key_tier" character varying(16) NOT NULL,
        "operation_name" character varying(512),
        "status" "public"."video_histories_status_enum" NOT NULL DEFAULT 'pending',
        "gemini_video_uri" text,
        "result_mime_type" character varying(128),
        "error_message" text,
        CONSTRAINT "PK_video_histories_id" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      ALTER TABLE "video_histories"
      ADD CONSTRAINT "FK_video_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_video_histories_user_id_created_at"
      ON "video_histories" ("user_id", "created_at" DESC)
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_video_histories_operation_name"
      ON "video_histories" ("operation_name")
      WHERE "operation_name" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."UQ_video_histories_operation_name"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_video_histories_user_id_created_at"`);
    await queryRunner.query(`ALTER TABLE "video_histories" DROP CONSTRAINT "FK_video_histories_user_id"`);
    await queryRunner.query(`DROP TABLE "video_histories"`);
    await queryRunner.query(`DROP TYPE "public"."video_histories_status_enum"`);
  }
}
