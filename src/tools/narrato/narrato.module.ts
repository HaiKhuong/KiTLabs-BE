import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { ModelsModule } from "../models/models.module";
import { LogsModule } from "../logs/logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { User } from "../users/user.entity";
import { NarratoController } from "./narrato.controller";
import { NarratoHistory } from "./narrato-history.entity";
import { NarratoProcessor } from "./narrato.processor";
import { NARRATO_QUEUE_NAME, NarratoService } from "./narrato.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: NARRATO_QUEUE_NAME }),
    TypeOrmModule.forFeature([NarratoHistory, User], "tool"),
    LogsModule,
    NotificationsModule,
    AudioModule,
    ModelsModule,
  ],
  controllers: [NarratoController],
  providers: [NarratoService, NarratoProcessor],
  exports: [NarratoService],
})
export class NarratoModule {}
