import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateSepayTransactionsTable1900000000016 implements MigrationInterface {
  name = "CreateSepayTransactionsTable1900000000016";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "sepay_transactions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "sepay_id" bigint NOT NULL,
        "gateway" character varying(50) NOT NULL,
        "transaction_date" character varying(50),
        "account_number" character varying(50) NOT NULL,
        "sub_account" character varying(50),
        "code" character varying(100),
        "content" text NOT NULL,
        "transfer_type" character varying(20) NOT NULL,
        "description" text,
        "transfer_amount" numeric(15,2) NOT NULL,
        "accumulated" numeric(15,2) DEFAULT 0,
        "reference_code" character varying(100),
        "user_id" uuid,
        "reward_exp" integer NOT NULL DEFAULT 0,
        "status" character varying(30) NOT NULL DEFAULT 'UNMATCHED',
        "raw_payload" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_sepay_transactions" PRIMARY KEY ("id")
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_sepay_transactions_sepay_id" ON "sepay_transactions" ("sepay_id");
      CREATE INDEX IF NOT EXISTS "IDX_sepay_transactions_user_id" ON "sepay_transactions" ("user_id");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "sepay_transactions";`);
  }
}

