import { MigrationInterface, QueryRunner } from "typeorm";

export class ImageEditHistories1800000000005 implements MigrationInterface {
  name = "ImageEditHistories1800000000005";

  public async up(queryRunner: QueryRunner): Promise<void> {
    const existing = await queryRunner.query(`SELECT to_regclass('public.image_edit_histories') AS t`);
    if (existing[0]?.t) {
      return;
    }
    await queryRunner.query(
      `DO $enum$ BEGIN CREATE TYPE "public"."image_edit_histories_status_enum" AS ENUM('pending', 'running', 'completed', 'failed', 'cancelled'); EXCEPTION WHEN duplicate_object THEN NULL; END $enum$`,
    );
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "image_edit_histories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "feature" character varying(32) NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "status" "public"."image_edit_histories_status_enum" NOT NULL DEFAULT 'pending',
        "input_path" text,
        "input_file_name" character varying(255),
        "result_path" text,
        "result_file_name" character varying(255),
        "options" jsonb,
        "error_message" text,
        "queue_job_id" character varying,
        CONSTRAINT "PK_image_edit_histories" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_image_edit_histories_user_feature_created" ON "image_edit_histories" ("user_id", "feature", "created_at")`,
    );
    await queryRunner.query(
      `DO $fk$ BEGIN ALTER TABLE "image_edit_histories" ADD CONSTRAINT "FK_image_edit_histories_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION; EXCEPTION WHEN duplicate_object THEN NULL; END $fk$`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "image_edit_histories" DROP CONSTRAINT IF EXISTS "FK_image_edit_histories_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "image_edit_histories"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."image_edit_histories_status_enum"`);
  }
}
