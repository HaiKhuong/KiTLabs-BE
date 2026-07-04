import { MigrationInterface, QueryRunner } from "typeorm";

export class AddVideoWorkflows1780000000000 implements MigrationInterface {
  name = "AddVideoWorkflows1780000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "video_workflows" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL DEFAULT 'default',
        "document" jsonb NOT NULL,
        "nodes_export" jsonb NOT NULL,
        "content_hash" character varying(64) NOT NULL,
        CONSTRAINT "PK_video_workflows_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "video_workflows"
      ADD CONSTRAINT "FK_video_workflows_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_video_workflows_user_id_name"
      ON "video_workflows" ("user_id", "name")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_video_workflows_user_id_name"`);
    await queryRunner.query(
      `ALTER TABLE "video_workflows" DROP CONSTRAINT "FK_video_workflows_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "video_workflows"`);
  }
}
