import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhiteboardIdeaHistories1794000000000 implements MigrationInterface {
  name = "AddWhiteboardIdeaHistories1794000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "whiteboard_idea_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "title" character varying(255) NOT NULL,
        "idea" text NOT NULL,
        "model" character varying(128) NOT NULL,
        "scenes" jsonb NOT NULL,
        CONSTRAINT "PK_whiteboard_idea_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "whiteboard_idea_histories"
      ADD CONSTRAINT "FK_whiteboard_idea_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_whiteboard_idea_histories_user_id_created_at"
      ON "whiteboard_idea_histories" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_whiteboard_idea_histories_user_id_created_at"`);
    await queryRunner.query(
      `ALTER TABLE "whiteboard_idea_histories" DROP CONSTRAINT "FK_whiteboard_idea_histories_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "whiteboard_idea_histories"`);
  }
}
