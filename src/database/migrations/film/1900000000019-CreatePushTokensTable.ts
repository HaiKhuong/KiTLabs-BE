import { MigrationInterface, QueryRunner } from "typeorm";

export class CreatePushTokensTable1900000000019 implements MigrationInterface {
  name = "CreatePushTokensTable1900000000019";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "push_tokens_platform_enum" AS ENUM('web', 'pwa_ios', 'pwa_android');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "push_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "user_id" uuid NOT NULL,
        "device_id" uuid,
        "token" text NOT NULL,
        "platform" "push_tokens_platform_enum" NOT NULL DEFAULT 'web',
        "user_agent" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_push_tokens_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_push_tokens_token" ON "push_tokens" ("token");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_push_tokens_user_id" ON "push_tokens" ("user_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_push_tokens_device_id" ON "push_tokens" ("device_id");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_push_tokens_device_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_push_tokens_user_id";`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_push_tokens_token";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "push_tokens";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "push_tokens_platform_enum";`);
  }
}
