import { MigrationInterface, QueryRunner } from "typeorm";

export class InitAuditSchema1760000001000 implements MigrationInterface {
  name = "InitAuditSchema1760000001000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`
      CREATE TABLE "spam_logs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "request_key" character varying(128) NOT NULL,
        "route_path" character varying(255) NOT NULL,
        "user_id" character varying(64),
        "ip_address" character varying(64),
        "payload" text,
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_spam_logs_id" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "spam_logs"`);
  }
}
