import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAudioCloneVoices1779000000000 implements MigrationInterface {
  name = "AddAudioCloneVoices1779000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audio_clone_voices" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid,
        "display_name" character varying(255) NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "ref_text" text NOT NULL,
        "file_path" character varying(1024) NOT NULL,
        "file_size" integer NOT NULL DEFAULT 0,
        "mime_type" character varying(64),
        CONSTRAINT "PK_audio_clone_voices_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_audio_clone_voices_file_name" UNIQUE ("file_name")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "audio_clone_voices"
      ADD CONSTRAINT "FK_audio_clone_voices_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_audio_clone_voices_user_id_created_at"
      ON "audio_clone_voices" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_audio_clone_voices_user_id_created_at"`);
    await queryRunner.query(`ALTER TABLE "audio_clone_voices" DROP CONSTRAINT "FK_audio_clone_voices_user_id"`);
    await queryRunner.query(`DROP TABLE "audio_clone_voices"`);
  }
}
