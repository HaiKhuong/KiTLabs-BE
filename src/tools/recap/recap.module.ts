import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { CreditHistory } from "../credits/credit-history.entity";
import { LogsModule } from "../logs/logs.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { User } from "../users/user.entity";
import { RecapController } from "./recap.controller";
import { RecapHistory } from "./recap-history.entity";
import { RecapProcessor } from "./recap.processor";
import { RECAP_QUEUE_NAME, RecapService } from "./recap.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: RECAP_QUEUE_NAME }),
    TypeOrmModule.forFeature([RecapHistory, User, CreditHistory], "tool"),
    LogsModule,
    NotificationsModule,
  ],
  controllers: [RecapController],
  providers: [RecapService, RecapProcessor],
  exports: [RecapService],
})
export class RecapModule {}
