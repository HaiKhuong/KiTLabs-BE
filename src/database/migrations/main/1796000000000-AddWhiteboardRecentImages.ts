import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhiteboardRecentImages1796000000000 implements MigrationInterface {
  name = "AddWhiteboardRecentImages1796000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "whiteboard_recent_images" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "original_name" character varying(512) NOT NULL,
        "mime_type" character varying(64),
        "file_size" integer NOT NULL DEFAULT 0,
        "last_used_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_whiteboard_recent_images_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "whiteboard_recent_images"
      ADD CONSTRAINT "FK_whiteboard_recent_images_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_whiteboard_recent_images_user_id_last_used_at"
      ON "whiteboard_recent_images" ("user_id", "last_used_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_whiteboard_recent_images_user_id_last_used_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "whiteboard_recent_images" DROP CONSTRAINT "FK_whiteboard_recent_images_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "whiteboard_recent_images"`);
  }
}
