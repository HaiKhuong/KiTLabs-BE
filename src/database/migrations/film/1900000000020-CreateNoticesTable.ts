import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateNoticesTable1900000000020 implements MigrationInterface {
  name = "CreateNoticesTable1900000000020";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "notices_action_type_enum" AS ENUM(
          'NONE',
          'LINK',
          'MODAL_ADD_TO_HOMESCREEN',
          'MODAL_PUSH_NOTIFICATION',
          'MODAL_MISSION',
          'MODAL_DONATE',
          'MODAL_LEADERBOARD'
        );
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "notices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP,
        "title" varchar,
        "message" text NOT NULL,
        "link_label" varchar,
        "action_type" "notices_action_type_enum" NOT NULL DEFAULT 'NONE',
        "action_url" varchar,
        "open_in_new_tab" boolean NOT NULL DEFAULT false,
        "display_order" integer NOT NULL DEFAULT 0,
        "repeat_interval_seconds" integer NOT NULL DEFAULT 180,
        "display_duration_seconds" integer NOT NULL DEFAULT 20,
        "is_active" boolean NOT NULL DEFAULT true,
        "start_time" TIMESTAMP WITH TIME ZONE,
        "end_time" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_notices_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_notices_active_order" ON "notices" ("is_active", "display_order");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_notices_active_order";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "notices";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "notices_action_type_enum";`);
  }
}
