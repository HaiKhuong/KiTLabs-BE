import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CreditHistory } from "../credits/credit-history.entity";
import { LogsModule } from "../logs/logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { AudioModule } from "../audio/audio.module";
import { User } from "../users/user.entity";
import { TranslateController } from "./translate.controller";
import { TranslateProcessor } from "./translate.processor";
import { TranslateHistory } from "./translate-history.entity";
import { GeminiSubtitleTranslateService } from "./gemini-subtitle-translate.service";
import { TRANSLATE_QUEUE_NAME, TranslateService } from "./translate.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: TRANSLATE_QUEUE_NAME }),
    TypeOrmModule.forFeature([TranslateHistory, User, CreditHistory], "tool"),
    LogsModule,
    NotificationsModule,
    AudioModule,
  ],
  controllers: [TranslateController],
  providers: [TranslateService, TranslateProcessor, GeminiSubtitleTranslateService],
})
export class TranslateModule {}
