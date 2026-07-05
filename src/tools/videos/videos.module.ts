import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { VideoWorkflow } from "./video-workflow.entity";
import { VideosAiService } from "./videos-ai.service";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";
import { VideosVoiceService } from "./videos-voice.service";

@Module({
  imports: [TypeOrmModule.forFeature([VideoWorkflow], "tool"), AudioModule],
  controllers: [VideosController],
  providers: [VideosService, VideosAiService, VideosVoiceService],
  exports: [VideosService, VideosAiService, VideosVoiceService],
})
export class VideosModule {}
