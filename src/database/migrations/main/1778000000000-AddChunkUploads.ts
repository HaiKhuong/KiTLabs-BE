import { MigrationInterface, QueryRunner } from "typeorm";

export class AddChunkUploads1778000000000 implements MigrationInterface {
  name = "AddChunkUploads1778000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."chunk_upload_status_enum" AS ENUM('init', 'uploading', 'merging', 'done', 'failed', 'cancelled')`,
    );

    await queryRunner.query(`
      CREATE TABLE "chunk_uploads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "upload_id" character varying(64) NOT NULL,
        "filename" text NOT NULL,
        "size" bigint NOT NULL,
        "chunk_size" integer NOT NULL,
        "total_chunks" integer NOT NULL,
        "uploaded_chunks" integer NOT NULL DEFAULT 0,
        "status" "public"."chunk_upload_status_enum" NOT NULL DEFAULT 'init',
        "user_id" character varying(100),
        "folder" character varying(200),
        "final_path" text,
        CONSTRAINT "PK_chunk_uploads_id" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_chunk_uploads_upload_id" UNIQUE ("upload_id")
      )
    `);

    await queryRunner.query(`CREATE INDEX "IDX_chunk_uploads_upload_id" ON "chunk_uploads" ("upload_id")`);
    await queryRunner.query(`CREATE INDEX "IDX_chunk_uploads_status" ON "chunk_uploads" ("status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "chunk_uploads"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."chunk_upload_status_enum"`);
  }
}
