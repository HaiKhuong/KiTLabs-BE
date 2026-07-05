import { MigrationInterface, QueryRunner } from "typeorm";

export class AddImageHistories1782000000000 implements MigrationInterface {
  name = "AddImageHistories1782000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "image_histories" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "prompt" text NOT NULL,
        "display_name" character varying(255) NOT NULL,
        "negative_prompt" text,
        "style" character varying(64) NOT NULL,
        "aspect_ratio" character varying(16) NOT NULL,
        "model" character varying(128) NOT NULL,
        "num_inference_steps" integer,
        "seed" integer,
        "status" "public"."translate_histories_status_enum" NOT NULL DEFAULT 'pending',
        "result_path" character varying,
        "result_file_name" character varying,
        "error_message" text,
        CONSTRAINT "PK_image_histories_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      ALTER TABLE "image_histories"
      ADD CONSTRAINT "FK_image_histories_user_id"
      FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_image_histories_user_id_created_at"
      ON "image_histories" ("user_id", "created_at" DESC)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."IDX_image_histories_user_id_created_at"`);
    await queryRunner.query(`ALTER TABLE "image_histories" DROP CONSTRAINT "FK_image_histories_user_id"`);
    await queryRunner.query(`DROP TABLE "image_histories"`);
  }
}
