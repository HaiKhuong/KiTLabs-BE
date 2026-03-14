import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { User } from "../users/user.entity";
import { Setting } from "./setting.entity";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { UserSetting } from "./user-setting.entity";

@Module({
  imports: [TypeOrmModule.forFeature([Setting, UserSetting, User], "tool")],
  controllers: [SettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
