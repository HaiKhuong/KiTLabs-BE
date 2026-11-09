import { MigrationInterface, QueryRunner } from "typeorm";

export class SeedBankAccountSetting1900000000015 implements MigrationInterface {
  name = "SeedBankAccountSetting1900000000015";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "settings" ("key", "value", "description", "is_public")
      VALUES (
        'BANK_ACCOUNT',
        '{"bankId": "MB", "bankName": "MBBank - Ngân hàng Quân Đội", "accountNo": "0331000123456", "accountName": "KITLABS FILM", "template": "compact2", "defaultMemo": "Ung ho phim", "isActive": true}'::jsonb,
        'Cấu hình tài khoản ngân hàng và mã QR VietQR nhận ủng hộ',
        true
      )
      ON CONFLICT ("key") DO NOTHING;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "settings" WHERE "key" = 'BANK_ACCOUNT';`);
  }
}

