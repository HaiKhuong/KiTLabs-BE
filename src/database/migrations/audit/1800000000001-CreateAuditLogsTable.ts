import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateAuditLogsTable1800000000001 implements MigrationInterface {
  name = "CreateAuditLogsTable1800000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "module" character varying(64) NOT NULL,
        "session_id" character varying(128) NOT NULL,
        "event" character varying(64) NOT NULL,
        "object_id" character varying(255),
        "object_name" text,
        "object_type" character varying(64),
        "error_code" character varying(64),
        "error_message" text,
        "page" character varying(255),
        "user_id" character varying(64),
        "device_id" character varying(128),
        "metadata" jsonb,
        "ip_address" character varying(64),
        "user_agent" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_module_event" ON "audit_logs" ("module", "event")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_session_id" ON "audit_logs" ("session_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_created_at" ON "audit_logs" ("created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "audit_logs"`);
  }
}

