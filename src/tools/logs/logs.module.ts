import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { LogsController } from "./logs.controller";
import { UserActionLog } from "./user-action-log.entity";
import { LogsService } from "./logs.service";

@Module({
  imports: [TypeOrmModule.forFeature([UserActionLog], "tool")],
  controllers: [LogsController],
  providers: [LogsService],
  exports: [LogsService],
})
export class LogsModule {}
