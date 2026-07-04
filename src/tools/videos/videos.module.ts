import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { VideoWorkflow } from "./video-workflow.entity";
import { VideosAiService } from "./videos-ai.service";
import { VideosController } from "./videos.controller";
import { VideosService } from "./videos.service";

@Module({
  imports: [TypeOrmModule.forFeature([VideoWorkflow], "tool")],
  controllers: [VideosController],
  providers: [VideosService, VideosAiService],
  exports: [VideosService, VideosAiService],
})
export class VideosModule {}
