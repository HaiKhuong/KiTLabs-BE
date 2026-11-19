import { MigrationInterface, QueryRunner } from "typeorm";

export class AddDesktopDeviceDiscoveryFields1800000000003 implements MigrationInterface {
  name = "AddDesktopDeviceDiscoveryFields1800000000003";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "desktop_devices" ADD COLUMN IF NOT EXISTS "hostname" character varying(150)`,
    );
    await queryRunner.query(
      `ALTER TABLE "desktop_devices" ADD COLUMN IF NOT EXISTS "is_configured" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "desktop_devices" DROP COLUMN IF EXISTS "is_configured"`);
    await queryRunner.query(`ALTER TABLE "desktop_devices" DROP COLUMN IF EXISTS "hostname"`);
  }
}
