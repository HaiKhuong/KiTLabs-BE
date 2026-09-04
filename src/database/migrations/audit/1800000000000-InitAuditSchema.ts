import { MigrationInterface, QueryRunner } from "typeorm";

export class InitAuditSchema1800000000000 implements MigrationInterface {
    name = 'InitAuditSchema1800000000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "spam_logs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "request_key" character varying(128) NOT NULL, "route_path" character varying(255) NOT NULL, "user_id" character varying(64), "ip_address" character varying(64), "payload" text, "created_at" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "PK_9c6b5443d7418b98ae4c53583bc" PRIMARY KEY ("id"))`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "spam_logs"`);
    }

}
