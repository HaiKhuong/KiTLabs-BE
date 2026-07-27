import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVideoWorkflowRuns1788000000000 implements MigrationInterface {
  name = "AddVideoWorkflowRuns1788000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "video_workflow_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "workflow_id" uuid NOT NULL,
        "workflow_name" character varying(255) NOT NULL,
        "status" character varying(32) NOT NULL,
        "started_at" TIMESTAMP,
        "finished_at" TIMESTAMP,
        "duration_ms" integer,
        "snapshot" jsonb NOT NULL,
        "summary" jsonb NOT NULL,
        "error_message" text,
        CONSTRAINT "PK_video_workflow_runs_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "video_workflow_runs"
      ADD CONSTRAINT "FK_video_workflow_runs_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      ALTER TABLE "video_workflow_runs"
      ADD CONSTRAINT "FK_video_workflow_runs_workflow_id"
      FOREIGN KEY ("workflow_id") REFERENCES "video_workflows"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_video_workflow_runs_user_workflow_created"
      ON "video_workflow_runs" ("user_id", "workflow_id", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_video_workflow_runs_user_workflow_created"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_workflow_runs" DROP CONSTRAINT IF EXISTS "FK_video_workflow_runs_workflow_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "video_workflow_runs" DROP CONSTRAINT IF EXISTS "FK_video_workflow_runs_user_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "video_workflow_runs"`);
  }
}
