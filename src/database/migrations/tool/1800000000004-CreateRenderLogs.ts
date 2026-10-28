import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateRenderLogs1800000000004 implements MigrationInterface {
  name = "CreateRenderLogs1800000000004";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "render_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid,
        "feature" character varying(64) NOT NULL,
        "history_id" uuid,
        "display_name" character varying(255),
        "data" jsonb NOT NULL DEFAULT '{}',
        CONSTRAINT "PK_render_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_render_logs_user_id_created_at" ON "render_logs" ("user_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_render_logs_feature_created_at" ON "render_logs" ("feature", "created_at")`,
    );
    await queryRunner.query(`
      DO $fk$ BEGIN
        ALTER TABLE "render_logs"
          ADD CONSTRAINT "FK_render_logs_user_id"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $fk$
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "render_logs" DROP CONSTRAINT IF EXISTS "FK_render_logs_user_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_render_logs_feature_created_at"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_render_logs_user_id_created_at"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "render_logs"`);
  }
}
