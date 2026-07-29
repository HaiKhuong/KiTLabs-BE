import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { GeminiVeoService } from "./gemini-veo.service";
import { VideoHistory } from "./video-history.entity";
import { VideoHistoryService } from "./video-history.service";
import { VideosController } from "./videos.controller";

@Module({
  imports: [TypeOrmModule.forFeature([VideoHistory], "tool")],
  controllers: [VideosController],
  providers: [GeminiVeoService, VideoHistoryService],
  exports: [GeminiVeoService],
})
export class VideosModule {}
