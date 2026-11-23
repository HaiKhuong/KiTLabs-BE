import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { GFlowModule } from "../gflow/gflow.module";
import { MuseModule } from "../muse/muse.module";
import { LogsModule } from "../logs/logs.module";
import { GeminiVeoService } from "./gemini-veo.service";
import { VideoHistory } from "./video-history.entity";
import { VideoHistoryService } from "./video-history.service";
import { VideosController } from "./videos.controller";

@Module({
  imports: [LogsModule, GFlowModule, MuseModule, TypeOrmModule.forFeature([VideoHistory], "tool")],
  controllers: [VideosController],
  providers: [GeminiVeoService, VideoHistoryService],
  exports: [GeminiVeoService],
})
export class VideosModule {}
