import { MigrationInterface, QueryRunner } from "typeorm";

export class MakeFacebookPagesAccountNullable1800000000009 implements MigrationInterface {
  name = "MakeFacebookPagesAccountNullable1800000000009";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "facebook_pages" DROP CONSTRAINT IF EXISTS "FK_facebook_pages_account";
      ALTER TABLE "facebook_pages" DROP CONSTRAINT IF EXISTS "UQ_facebook_pages_account_page";
      ALTER TABLE "facebook_pages" ALTER COLUMN "account_id" DROP NOT NULL;
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'UQ_facebook_pages_page_id'
        ) THEN
          ALTER TABLE "facebook_pages" ADD CONSTRAINT "UQ_facebook_pages_page_id" UNIQUE ("page_id");
        END IF;
      END $$;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "facebook_pages" DROP CONSTRAINT IF EXISTS "UQ_facebook_pages_page_id";
    `);
  }
}

