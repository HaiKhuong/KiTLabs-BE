import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserAuthTypeForGuest1761000000000 implements MigrationInterface {
  name = "AddUserAuthTypeForGuest1761000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'users_auth_type_enum') THEN
          CREATE TYPE "public"."users_auth_type_enum" AS ENUM('account', 'guest');
        END IF;
      END
      $$;
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "auth_type" "public"."users_auth_type_enum" NOT NULL DEFAULT 'account'
    `);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "user_name" DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL`);

    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_users_auth_type" ON "users" ("auth_type")`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_guest_device_id" ON "users" ("device_id") WHERE "auth_type" = 'guest' AND "device_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_guest_ip" ON "users" ("ip") WHERE "auth_type" = 'guest' AND "ip" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_users_guest_mac" ON "users" ("mac") WHERE "auth_type" = 'guest' AND "mac" IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD CONSTRAINT "CHK_users_auth_identity"
      CHECK (
        ("auth_type" = 'account' AND "user_name" IS NOT NULL AND "password_hash" IS NOT NULL)
        OR
        (
          "auth_type" = 'guest'
          AND "user_name" IS NULL
          AND "password_hash" IS NULL
          AND ("device_id" IS NOT NULL OR "ip" IS NOT NULL OR "mac" IS NOT NULL)
        )
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "CHK_users_auth_identity"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_guest_mac"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_guest_ip"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_guest_device_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_users_auth_type"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN IF EXISTS "auth_type"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."users_auth_type_enum"`);

    await queryRunner.query(`
      UPDATE "users"
      SET
        "user_name" = COALESCE("user_name", 'guest_' || SUBSTRING("id"::text, 1, 12)),
        "password_hash" = COALESCE("password_hash", 'guest_password_hash')
      WHERE "user_name" IS NULL OR "password_hash" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "user_name" SET NOT NULL`);
    await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "password_hash" SET NOT NULL`);
  }
}
