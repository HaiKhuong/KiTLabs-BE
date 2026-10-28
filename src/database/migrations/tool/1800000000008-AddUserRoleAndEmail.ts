import { MigrationInterface, QueryRunner } from "typeorm";

export class AddUserRoleAndEmail1800000000008 implements MigrationInterface {
  name = "AddUserRoleAndEmail1800000000008";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" 
      ADD COLUMN IF NOT EXISTS "email" character varying(150),
      ADD COLUMN IF NOT EXISTS "role" character varying(32) NOT NULL DEFAULT 'USER';
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_users_email'
        ) THEN
          ALTER TABLE "users" ADD CONSTRAINT "UQ_users_email" UNIQUE ("email");
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "UQ_users_email";
      ALTER TABLE "users" DROP COLUMN IF EXISTS "role";
      ALTER TABLE "users" DROP COLUMN IF EXISTS "email";
    `);
  }
}
