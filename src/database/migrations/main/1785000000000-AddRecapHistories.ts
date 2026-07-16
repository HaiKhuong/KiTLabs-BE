import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRecapHistories1785000000000 implements MigrationInterface {
  name = "AddRecapHistories1785000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "recap_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "movie_id" uuid,
        "engine_config" jsonb,
        "script_payload" jsonb,
        "timeline_payload" jsonb,
        "status" "public"."translate_histories_status_enum" NOT NULL DEFAULT 'pending',
        "cost" numeric(12,2) NOT NULL DEFAULT '0',
        "result_path" character varying,
        "result_file_name" character varying,
        "error_message" text,
        "queue_job_id" character varying,
        CONSTRAINT "PK_recap_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "recap_histories"
      ADD CONSTRAINT "FK_recap_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_recap_histories_user_id_created_at"
      ON "recap_histories" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_recap_histories_user_id_created_at"`);
    await queryRunner.query(`ALTER TABLE "recap_histories" DROP CONSTRAINT "FK_recap_histories_user_id"`);
    await queryRunner.query(`DROP TABLE "recap_histories"`);
  }
}
