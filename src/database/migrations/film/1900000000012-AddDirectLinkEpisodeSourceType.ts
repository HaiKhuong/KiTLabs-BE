import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDirectLinkEpisodeSourceType1900000000012 implements MigrationInterface {
  name = "AddDirectLinkEpisodeSourceType1900000000012";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "public"."episode_sources_source_type_enum" ADD VALUE IF NOT EXISTS 'DIRECT_LINK'`,
    );
  }

  public async down(): Promise<void> {
    // PostgreSQL enum values cannot be removed safely without recreating the enum.
  }
}
