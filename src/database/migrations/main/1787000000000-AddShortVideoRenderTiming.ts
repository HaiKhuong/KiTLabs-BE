import { MigrationInterface, QueryRunner } from "typeorm";

export class AddShortVideoRenderTiming1787000000000 implements MigrationInterface {
  name = "AddShortVideoRenderTiming1787000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "short_video_histories"
      ADD COLUMN "render_started_at" TIMESTAMP,
      ADD COLUMN "render_finished_at" TIMESTAMP,
      ADD COLUMN "render_duration_ms" integer
    `);

    // Approximate timing for existing completed rows.
    await queryRunner.query(`
      UPDATE "short_video_histories"
      SET
        "render_started_at" = "created_at",
        "render_finished_at" = "updated_at",
        "render_duration_ms" = GREATEST(
          0,
          ROUND(EXTRACT(EPOCH FROM ("updated_at" - "created_at")) * 1000)::integer
        )
      WHERE "status" = 'completed'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "short_video_histories"
      DROP COLUMN "render_duration_ms",
      DROP COLUMN "render_finished_at",
      DROP COLUMN "render_started_at"
    `);
  }
}
