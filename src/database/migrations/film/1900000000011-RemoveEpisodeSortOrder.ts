import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveEpisodeSortOrder1900000000011 implements MigrationInterface {
  name = "RemoveEpisodeSortOrder1900000000011";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "episodes" DROP COLUMN IF EXISTS "sort_order"`);
  }

  public async down(): Promise<void> {
    // Intentionally empty: episode ordering is represented by episode_number.
  }
}
