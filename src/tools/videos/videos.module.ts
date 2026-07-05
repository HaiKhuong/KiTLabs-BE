import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { VideoWorkflow } from "./video-workflow.entity";
import { VideosAiService } from "./videos-ai.service";
import { VideosController } from "./videos.controller";
import { VideosImageService } from "./videos-image.service";
import { VideosJobsService } from "./videos-jobs.service";
import { VideosService } from "./videos.service";
import { VideosVoiceService } from "./videos-voice.service";

@Module({
  imports: [TypeOrmModule.forFeature([VideoWorkflow], "tool"), AudioModule, ToolsRealtimeModule],
  controllers: [VideosController],
  providers: [VideosService, VideosAiService, VideosVoiceService, VideosImageService, VideosJobsService],
  exports: [VideosService, VideosAiService, VideosVoiceService, VideosImageService, VideosJobsService],
})
export class VideosModule {}
