import { MigrationInterface, QueryRunner } from "typeorm";

export class AddMissionsAndExpSystem1900000000005 implements MigrationInterface {
  name = "AddMissionsAndExpSystem1900000000005";

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. Enum UserMissionStatus
    await queryRunner.query(`
      DO $$ BEGIN
        CREATE TYPE "public"."user_mission_status_enum" AS ENUM('IN_PROGRESS', 'CLAIMABLE', 'CLAIMED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 2. Table: missions
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "missions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "code" character varying(50) NOT NULL,
        "title" character varying(150) NOT NULL,
        "description" text NOT NULL,
        "reward_exp" integer NOT NULL,
        "max_daily_reward" integer,
        "target_count" integer NOT NULL DEFAULT 1,
        "target_unit" character varying(50) NOT NULL DEFAULT 'lần',
        "reset_daily" boolean NOT NULL DEFAULT true,
        "is_active" boolean NOT NULL DEFAULT true,
        "display_order" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_missions_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_missions_code" ON "missions" ("code") WHERE "deleted_at" IS NULL;
    `);

    // 3. Table: user_mission_progress
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_mission_progress" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "user_id" uuid NOT NULL,
        "mission_code" character varying(50) NOT NULL,
        "date_key" character varying(10) NOT NULL DEFAULT 'ALL',
        "current_count" integer NOT NULL DEFAULT 0,
        "claimed_exp" integer NOT NULL DEFAULT 0,
        "status" "public"."user_mission_status_enum" NOT NULL DEFAULT 'IN_PROGRESS',
        "metadata" jsonb,
        CONSTRAINT "PK_user_mission_progress_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_mission_progress_user_code_date" ON "user_mission_progress" ("user_id", "mission_code", "date_key") WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_mission_progress_user_id" ON "user_mission_progress" ("user_id");
    `);

    // 4. Table: user_exp_histories
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_exp_histories" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "user_id" uuid NOT NULL,
        "mission_code" character varying(50),
        "amount" integer NOT NULL,
        "balance_after" bigint NOT NULL,
        "title" character varying(150) NOT NULL,
        "description" text,
        "raw_data" jsonb,
        CONSTRAINT "PK_user_exp_histories_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_exp_histories_user_id" ON "user_exp_histories" ("user_id");
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_exp_histories_created_at" ON "user_exp_histories" ("created_at");
    `);

    // 5. Table: user_referrals
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "user_referrals" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "referrer_user_id" uuid NOT NULL,
        "referee_user_id" uuid NOT NULL,
        "ip_address" character varying(64),
        "device_token" character varying(100),
        CONSTRAINT "PK_user_referrals_id" PRIMARY KEY ("id")
      );
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_user_referrals_referrer_referee" ON "user_referrals" ("referrer_user_id", "referee_user_id") WHERE "deleted_at" IS NULL;
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_user_referrals_referrer_ip" ON "user_referrals" ("referrer_user_id", "ip_address");
    `);

    // 6. Seed initial 5 missions
    await queryRunner.query(`
      INSERT INTO "missions" ("code", "title", "description", "reward_exp", "max_daily_reward", "target_count", "target_unit", "reset_daily", "is_active", "display_order")
      VALUES
        ('DAILY_CHECKIN', 'Điểm danh hàng ngày', 'Vào trang mỗi ngày để tích lũy tu vi và nhận phần thưởng tu tiên.', 10, 10, 1, 'lần', true, true, 1),
        ('INTERACTIVE_COMMENT', 'Bình luận tương tác', 'Để lại bình luận luận đạo dưới các bộ phim yêu thích (+10 EXP/lần, tối đa 3 lần/ngày).', 10, 30, 3, 'bình luận', true, true, 2),
        ('SHARE_LINK_REF', 'Chia sẻ link phim (Ref)', 'Chia sẻ liên kết phim kèm mã giới thiệu đến đạo hữu khác để nhận thưởng khi có người click xem.', 15, NULL, 1, 'lượt', false, true, 3),
        ('WATCH_MOVIE_TIME', 'Xem phim tích lũy', 'Xem phim mỗi ngày để tích lũy chân khí (+1 EXP / phút, tối đa 180 phút/ngày).', 1, 180, 180, 'phút', true, true, 4),
        ('DONATE_BANK', 'Donate ủng hộ ngân hàng', 'Ủng hộ ngân quỹ duy trì máy chủ tu tiên (Quy đổi +3 EXP / 1.000đ, không giới hạn).', 3, NULL, 0, '1.000đ', false, true, 5)
      ON CONFLICT ("code") DO NOTHING;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "user_referrals";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_exp_histories";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "user_mission_progress";`);
    await queryRunner.query(`DROP TABLE IF EXISTS "missions";`);
    await queryRunner.query(`DROP TYPE IF EXISTS "public"."user_mission_status_enum";`);
  }
}

