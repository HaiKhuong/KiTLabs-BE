import { Module } from "@nestjs/common";

import { HistoriesController } from "./histories.controller";
import { HistoriesService } from "./histories.service";

@Module({
  controllers: [HistoriesController],
  providers: [HistoriesService],
  exports: [HistoriesService],
})
export class HistoriesModule {}
