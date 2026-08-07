import { MigrationInterface, QueryRunner } from "typeorm";

export class AddAudioHistoryDurationSec1797000000000 implements MigrationInterface {
  name = "AddAudioHistoryDurationSec1797000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      ADD COLUMN "duration_sec" double precision
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_histories"
      DROP COLUMN "duration_sec"
    `);
  }
}
