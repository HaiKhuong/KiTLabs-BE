import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { ShortVideoController } from "./shortvideo.controller";
import { ShortVideoHistory } from "./shortvideo-history.entity";
import { ShortVideoProcessor } from "./shortvideo.processor";
import { SHORTVIDEO_QUEUE_NAME, ShortVideoService } from "./shortvideo.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: SHORTVIDEO_QUEUE_NAME }),
    TypeOrmModule.forFeature([ShortVideoHistory], "tool"),
    ToolsRealtimeModule,
    AudioModule,
  ],
  controllers: [ShortVideoController],
  providers: [ShortVideoService, ShortVideoProcessor],
  exports: [ShortVideoService],
})
export class ShortVideoModule {}
