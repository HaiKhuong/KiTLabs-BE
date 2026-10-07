import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DatabaseModule } from "../../database/database.module";
import { AUDIO_QUEUE_NAME } from "../audio/audio.service";
import { IMAGE_EDIT_QUEUE_NAME } from "../image-edit/image-edit.constants";
import { NARRATO_QUEUE_NAME } from "../narrato/narrato.service";
import { RECAP_QUEUE_NAME } from "../recap/recap.service";
import { SHORTVIDEO_QUEUE_NAME } from "../shortvideo/shortvideo.service";
import { TRANSLATE_QUEUE_NAME } from "../translate/translate.service";
import { User } from "../users/user.entity";
import { WHITEBOARD_QUEUE_NAME } from "../whiteboard/whiteboard.service";
import { RenderQueueResetService } from "./render-queue-reset.service";
import { RuntimeHealthService } from "./runtime-health.service";
import { Setting } from "./setting.entity";
import { SettingsController } from "./settings.controller";
import { SettingsService } from "./settings.service";
import { UserSettingProfile } from "./user-setting-profile.entity";
import { UserSetting } from "./user-setting.entity";

@Module({
  imports: [
    DatabaseModule,
    TypeOrmModule.forFeature([Setting, UserSetting, UserSettingProfile, User], "tool"),
    BullModule.registerQueue(
      { name: TRANSLATE_QUEUE_NAME },
      { name: RECAP_QUEUE_NAME },
      { name: NARRATO_QUEUE_NAME },
      { name: AUDIO_QUEUE_NAME },
      { name: SHORTVIDEO_QUEUE_NAME },
      { name: WHITEBOARD_QUEUE_NAME },
      { name: IMAGE_EDIT_QUEUE_NAME },
    ),
  ],
  controllers: [SettingsController],
  providers: [SettingsService, RuntimeHealthService, RenderQueueResetService],
  exports: [SettingsService],
})
export class SettingsModule {}
