import { Module } from "@nestjs/common";

import { VideosModule } from "../videos/videos.module";
import { ImagesController } from "./images.controller";

@Module({
  imports: [VideosModule],
  controllers: [ImagesController],
})
export class ImagesModule {}
