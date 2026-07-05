import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { VideosModule } from "../videos/videos.module";
import { ImageHistory } from "./image-history.entity";
import { ImagesController } from "./images.controller";
import { ImagesHistoryService } from "./images-history.service";
import { ImagesJobsService } from "./images-jobs.service";

@Module({
  imports: [VideosModule, TypeOrmModule.forFeature([ImageHistory], "tool")],
  controllers: [ImagesController],
  providers: [ImagesJobsService, ImagesHistoryService],
})
export class ImagesModule {}
