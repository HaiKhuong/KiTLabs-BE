import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPlatformDesktopDevices1800000000002 implements MigrationInterface {
  name = "AddPlatformDesktopDevices1800000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "desktop_devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "device_id" character varying(128) NOT NULL,
        "label" character varying(150) NOT NULL DEFAULT '',
        "note" text,
        "is_active" boolean NOT NULL DEFAULT true,
        "allowed_menus" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "app_version" character varying(64),
        "last_ip" character varying(64),
        "last_seen_at" TIMESTAMP,
        CONSTRAINT "PK_desktop_devices" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_desktop_devices_device_id" UNIQUE ("device_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "desktop_devices"`);
  }
}
