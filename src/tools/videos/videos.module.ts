import { Module } from "@nestjs/common";

import { GeminiVeoService } from "./gemini-veo.service";
import { VideosController } from "./videos.controller";

@Module({
  controllers: [VideosController],
  providers: [GeminiVeoService],
  exports: [GeminiVeoService],
})
export class VideosModule {}
