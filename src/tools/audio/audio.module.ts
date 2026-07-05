import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CreditHistory } from "../credits/credit-history.entity";
import { LogsModule } from "../logs/logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { User } from "../users/user.entity";
import { AudioController } from "./audio.controller";
import { AudioCloneVoice } from "./audio-clone-voice.entity";
import { AudioHistory } from "./audio-history.entity";
import { AudioOmnivoiceRunner } from "./audio-omnivoice.runner";
import { AudioProcessor } from "./audio.processor";
import { AUDIO_QUEUE_NAME, AudioService } from "./audio.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: AUDIO_QUEUE_NAME }),
    TypeOrmModule.forFeature([AudioHistory, AudioCloneVoice, User, CreditHistory], "tool"),
    LogsModule,
    NotificationsModule,
  ],
  controllers: [AudioController],
  providers: [AudioService, AudioOmnivoiceRunner, AudioProcessor],
  exports: [AudioService],
})
export class AudioModule {}
