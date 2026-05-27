import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAudioHistories1775000000000 implements MigrationInterface {
  name = "AddAudioHistories1775000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audio_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "input_text" text NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "voice_mode" character varying(16) NOT NULL,
        "voice_id" character varying(64),
        "engine_config" jsonb,
        "status" "public"."translate_histories_status_enum" NOT NULL DEFAULT 'pending',
        "cost" numeric(12,2) NOT NULL DEFAULT '0',
        "result_path" character varying,
        "result_file_name" character varying,
        "error_message" text,
        "queue_job_id" character varying,
        CONSTRAINT "PK_audio_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      ADD CONSTRAINT "FK_audio_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_audio_histories_user_id_created_at"
      ON "audio_histories" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_audio_histories_user_id_created_at"`);
    await queryRunner.query(`ALTER TABLE "audio_histories" DROP CONSTRAINT "FK_audio_histories_user_id"`);
    await queryRunner.query(`DROP TABLE "audio_histories"`);
  }
}
