import { MigrationInterface, QueryRunner } from "typeorm";

export class AutoToolMigration1774015171109 implements MigrationInterface {
    name = 'AutoToolMigration1774015171109'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "download_histories" DROP CONSTRAINT "FK_download_histories_user_id"`);
        await queryRunner.query(`ALTER TABLE "user_action_logs" DROP CONSTRAINT "FK_user_action_logs_user_id"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_notifications_user_id"`);
        await queryRunner.query(`ALTER TABLE "translate_histories" DROP CONSTRAINT "FK_translate_histories_user_id"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "FK_user_settings_user_id"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "FK_user_settings_profile_id"`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP CONSTRAINT "FK_user_setting_profiles_user_id"`);
        await queryRunner.query(`ALTER TABLE "credit_histories" DROP CONSTRAINT "FK_credit_histories_user_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_settings_profile_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_user_setting_profiles_user_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_users_auth_type"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_users_guest_device_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_users_guest_ip"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_users_guest_mac"`);
        await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "CHK_users_auth_identity"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "UQ_user_settings_profile_type_code"`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP CONSTRAINT "UQ_user_setting_profiles_user_type_name"`);
        await queryRunner.query(`ALTER TABLE "settings" DROP CONSTRAINT "UQ_settings_type_code"`);
        await queryRunner.query(`CREATE TYPE "public"."video_downloads_status_enum" AS ENUM('pending', 'downloading', 'completed', 'failed')`);
        await queryRunner.query(`CREATE TABLE "video_downloads" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP NOT NULL DEFAULT now(), "updated_at" TIMESTAMP NOT NULL DEFAULT now(), "user_id" uuid NOT NULL, "order_number" character varying(10) NOT NULL, "aweme_id" character varying(100) NOT NULL, "date" character varying(8) NOT NULL, "file_name" character varying(255) NOT NULL, "video_url" text NOT NULL, "description" text, "status" "public"."video_downloads_status_enum" NOT NULL DEFAULT 'pending', "gopeed_task_id" character varying(100), "downloaded_path" character varying(500), "error_message" text, CONSTRAINT "PK_c95e98526010ce5c0020cd7ebd8" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cac8f339fba055ecf22101d617" ON "video_downloads" ("user_id", "aweme_id") `);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "UQ_872896087063fca0d4331174584" UNIQUE ("profile_id", "type", "code")`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" ADD CONSTRAINT "UQ_39dda6964a6ec61bb705e59ef96" UNIQUE ("user_id", "type", "name")`);
        await queryRunner.query(`ALTER TABLE "settings" ADD CONSTRAINT "UQ_fd853d2c834ea0cdbddd559145b" UNIQUE ("type", "code")`);
        await queryRunner.query(`ALTER TABLE "download_histories" ADD CONSTRAINT "FK_c69db04907e7f247cb5d765e91b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "video_downloads" ADD CONSTRAINT "FK_9e39f2c28373838bf4939921a19" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_action_logs" ADD CONSTRAINT "FK_d06878728aab3d43b700c6c1209" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_9a8a82462cab47c73d25f49261f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "translate_histories" ADD CONSTRAINT "FK_1ace86d2c04a777e46116f17090" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "FK_4ed056b9344e6f7d8d46ec4b302" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "FK_a1e4d3d1efabbf3457c843f2893" FOREIGN KEY ("profile_id") REFERENCES "user_setting_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" ADD CONSTRAINT "FK_3db250332ff7247646302d2da3f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "credit_histories" ADD CONSTRAINT "FK_e5057ea052aeca7d0053e769cd3" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "credit_histories" DROP CONSTRAINT "FK_e5057ea052aeca7d0053e769cd3"`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP CONSTRAINT "FK_3db250332ff7247646302d2da3f"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "FK_a1e4d3d1efabbf3457c843f2893"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "FK_4ed056b9344e6f7d8d46ec4b302"`);
        await queryRunner.query(`ALTER TABLE "translate_histories" DROP CONSTRAINT "FK_1ace86d2c04a777e46116f17090"`);
        await queryRunner.query(`ALTER TABLE "notifications" DROP CONSTRAINT "FK_9a8a82462cab47c73d25f49261f"`);
        await queryRunner.query(`ALTER TABLE "user_action_logs" DROP CONSTRAINT "FK_d06878728aab3d43b700c6c1209"`);
        await queryRunner.query(`ALTER TABLE "video_downloads" DROP CONSTRAINT "FK_9e39f2c28373838bf4939921a19"`);
        await queryRunner.query(`ALTER TABLE "download_histories" DROP CONSTRAINT "FK_c69db04907e7f247cb5d765e91b"`);
        await queryRunner.query(`ALTER TABLE "settings" DROP CONSTRAINT "UQ_fd853d2c834ea0cdbddd559145b"`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" DROP CONSTRAINT "UQ_39dda6964a6ec61bb705e59ef96"`);
        await queryRunner.query(`ALTER TABLE "user_settings" DROP CONSTRAINT "UQ_872896087063fca0d4331174584"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cac8f339fba055ecf22101d617"`);
        await queryRunner.query(`DROP TABLE "video_downloads"`);
        await queryRunner.query(`DROP TYPE "public"."video_downloads_status_enum"`);
        await queryRunner.query(`ALTER TABLE "settings" ADD CONSTRAINT "UQ_settings_type_code" UNIQUE ("type", "code")`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" ADD CONSTRAINT "UQ_user_setting_profiles_user_type_name" UNIQUE ("user_id", "type", "name")`);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "UQ_user_settings_profile_type_code" UNIQUE ("type", "code", "profile_id")`);
        await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "CHK_users_auth_identity" CHECK ((((auth_type = 'account'::users_auth_type_enum) AND (user_name IS NOT NULL) AND (password_hash IS NOT NULL)) OR ((auth_type = 'guest'::users_auth_type_enum) AND (user_name IS NULL) AND (password_hash IS NULL) AND ((device_id IS NOT NULL) OR (ip IS NOT NULL) OR (mac IS NOT NULL)))))`);
        await queryRunner.query(`CREATE INDEX "IDX_users_guest_mac" ON "users" ("mac") WHERE ((auth_type = 'guest'::users_auth_type_enum) AND (mac IS NOT NULL))`);
        await queryRunner.query(`CREATE INDEX "IDX_users_guest_ip" ON "users" ("ip") WHERE ((auth_type = 'guest'::users_auth_type_enum) AND (ip IS NOT NULL))`);
        await queryRunner.query(`CREATE INDEX "IDX_users_guest_device_id" ON "users" ("device_id") WHERE ((auth_type = 'guest'::users_auth_type_enum) AND (device_id IS NOT NULL))`);
        await queryRunner.query(`CREATE INDEX "IDX_users_auth_type" ON "users" ("auth_type") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_setting_profiles_user_type" ON "user_setting_profiles" ("user_id", "type") `);
        await queryRunner.query(`CREATE INDEX "IDX_user_settings_profile_id" ON "user_settings" ("profile_id") `);
        await queryRunner.query(`ALTER TABLE "credit_histories" ADD CONSTRAINT "FK_credit_histories_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_setting_profiles" ADD CONSTRAINT "FK_user_setting_profiles_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "FK_user_settings_profile_id" FOREIGN KEY ("profile_id") REFERENCES "user_setting_profiles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_settings" ADD CONSTRAINT "FK_user_settings_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "translate_histories" ADD CONSTRAINT "FK_translate_histories_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "notifications" ADD CONSTRAINT "FK_notifications_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "user_action_logs" ADD CONSTRAINT "FK_user_action_logs_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "download_histories" ADD CONSTRAINT "FK_download_histories_user_id" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
