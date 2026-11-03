import { MigrationInterface, QueryRunner } from "typeorm";

export class AddThumbnailPathToFacebookPosts1800000000010 implements MigrationInterface {
  name = "AddThumbnailPathToFacebookPosts1800000000010";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "facebook_posts" ADD COLUMN IF NOT EXISTS "thumbnail_path" text;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "facebook_posts" DROP COLUMN IF EXISTS "thumbnail_path";
    `);
  }
}

