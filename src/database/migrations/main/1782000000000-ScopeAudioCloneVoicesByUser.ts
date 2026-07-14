import { MigrationInterface, QueryRunner } from "typeorm";

export class ScopeAudioCloneVoicesByUser1782000000000 implements MigrationInterface {
  name = "ScopeAudioCloneVoicesByUser1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_clone_voices"
      DROP CONSTRAINT IF EXISTS "UQ_audio_clone_voices_file_name"
    `);
    await queryRunner.query(`
      DROP INDEX IF EXISTS "IDX_audio_clone_voices_file_name"
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_audio_clone_voices_user_id_file_name"
      ON "audio_clone_voices" ("user_id", "file_name")
      WHERE "user_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_audio_clone_voices_user_id_file_name"`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_audio_clone_voices_file_name"
      ON "audio_clone_voices" ("file_name")
    `);
    await queryRunner.query(`
      ALTER TABLE "audio_clone_voices"
      ADD CONSTRAINT "UQ_audio_clone_voices_file_name" UNIQUE ("file_name")
    `);
  }
}
