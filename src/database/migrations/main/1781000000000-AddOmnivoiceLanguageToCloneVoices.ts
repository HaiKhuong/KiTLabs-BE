import { MigrationInterface, QueryRunner } from "typeorm";

export class AddOmnivoiceLanguageToCloneVoices1781000000000 implements MigrationInterface {
  name = "AddOmnivoiceLanguageToCloneVoices1781000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_clone_voices"
      ADD COLUMN "omnivoice_language" character varying(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "audio_clone_voices"
      DROP COLUMN "omnivoice_language"
    `);
  }
}
