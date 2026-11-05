import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEpisodeSourceExternalReference1900000000009 implements MigrationInterface {
  name = "AddEpisodeSourceExternalReference1900000000009";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "episode_sources" ADD COLUMN IF NOT EXISTS "external_provider" varchar(32)`);
    await queryRunner.query(`ALTER TABLE "episode_sources" ADD COLUMN IF NOT EXISTS "external_reference" varchar(128)`);
    await queryRunner.query(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_episode_sources_external" ON "episode_sources" ("external_provider", "external_reference")`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_episode_sources_external"`);
    await queryRunner.query(`ALTER TABLE "episode_sources" DROP COLUMN IF EXISTS "external_reference"`);
    await queryRunner.query(`ALTER TABLE "episode_sources" DROP COLUMN IF EXISTS "external_provider"`);
  }
}
