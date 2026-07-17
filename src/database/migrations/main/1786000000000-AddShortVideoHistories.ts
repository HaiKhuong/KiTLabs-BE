import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShortVideoHistories1786000000000 implements MigrationInterface {
  name = "AddShortVideoHistories1786000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "short_video_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "node_id" character varying(255),
        "display_name" character varying(255) NOT NULL,
        "spec" jsonb,
        "engine_config" jsonb,
        "status" "public"."translate_histories_status_enum" NOT NULL DEFAULT 'pending',
        "result_path" character varying,
        "result_file_name" character varying,
        "error_message" text,
        "queue_job_id" character varying,
        CONSTRAINT "PK_short_video_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "short_video_histories"
      ADD CONSTRAINT "FK_short_video_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_short_video_histories_user_id_created_at"
      ON "short_video_histories" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_short_video_histories_user_id_created_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "short_video_histories" DROP CONSTRAINT "FK_short_video_histories_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "short_video_histories"`);
  }
}
