import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { User } from "../users/user.entity";
import { Setting } from "./setting.entity";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { RuntimeHealthService } from "./runtime-health.service";
import { UserSettingProfile } from "./user-setting-profile.entity";
import { UserSetting } from "./user-setting.entity";
import { DatabaseModule } from "../../database/database.module";

@Module({
  imports: [
    DatabaseModule,
    TypeOrmModule.forFeature([Setting, UserSetting, UserSettingProfile, User], "tool"),
  ],
  controllers: [SettingsController],
  providers: [SettingsService, RuntimeHealthService],
  exports: [SettingsService],
})
export class SettingsModule {}
