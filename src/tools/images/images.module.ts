import { Module } from "@nestjs/common";

import { VideosModule } from "../videos/videos.module";
import { ImagesController } from "./images.controller";
import { ImagesJobsService } from "./images-jobs.service";

@Module({
  imports: [VideosModule],
  controllers: [ImagesController],
  providers: [ImagesJobsService],
})
export class ImagesModule {}
