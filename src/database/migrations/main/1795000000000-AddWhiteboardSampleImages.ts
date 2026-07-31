import { MigrationInterface, QueryRunner } from "typeorm";

export class AddWhiteboardSampleImages1795000000000 implements MigrationInterface {
  name = "AddWhiteboardSampleImages1795000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "whiteboard_sample_images" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "file_name" character varying(255) NOT NULL,
        "original_name" character varying(512) NOT NULL,
        "mime_type" character varying(64),
        "file_size" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_whiteboard_sample_images_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "whiteboard_sample_images"
      ADD CONSTRAINT "FK_whiteboard_sample_images_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_whiteboard_sample_images_user_id_created_at"
      ON "whiteboard_sample_images" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_whiteboard_sample_images_user_id_created_at"`);
    await queryRunner.query(
      `ALTER TABLE "whiteboard_sample_images" DROP CONSTRAINT "FK_whiteboard_sample_images_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "whiteboard_sample_images"`);
  }
}
