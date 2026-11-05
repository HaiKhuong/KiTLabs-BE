import { MigrationInterface, QueryRunner } from "typeorm";

export class AddEpisodeOrderingAndSingleActiveSource1900000000010 implements MigrationInterface {
  name = "AddEpisodeOrderingAndSingleActiveSource1900000000010";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY episode_id ORDER BY priority ASC, created_at DESC) AS position
        FROM episode_sources WHERE is_active = true AND deleted_at IS NULL
      )
      UPDATE episode_sources SET is_active = false
      FROM ranked WHERE episode_sources.id = ranked.id AND ranked.position > 1
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_episode_sources_one_active"
      ON "episode_sources" ("episode_id") WHERE "is_active" = true AND "deleted_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_episode_sources_one_active"`);
  }
}
