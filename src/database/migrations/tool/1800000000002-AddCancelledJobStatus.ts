import { MigrationInterface, QueryRunner } from "typeorm";

const ENUM_TYPES = [
  "translate_histories_status_enum",
  "recap_histories_status_enum",
  "narrato_histories_status_enum",
  "audio_histories_status_enum",
  "short_video_histories_status_enum",
  "whiteboard_histories_status_enum",
] as const;

export class AddCancelledJobStatus1800000000002 implements MigrationInterface {
  name = "AddCancelledJobStatus1800000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const typeName of ENUM_TYPES) {
      await queryRunner.query(
        `DO $enum$ BEGIN ALTER TYPE "public"."${typeName}" ADD VALUE IF NOT EXISTS 'cancelled'; EXCEPTION WHEN undefined_object THEN NULL; END $enum$`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres cannot remove a value from an enum safely.
  }
}
