import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { IMAGE_EDIT_QUEUE_NAME } from "./image-edit.constants";
import { ImageEditController } from "./image-edit.controller";
import { ImageEditHistory } from "./image-edit-history.entity";
import { ImageEditHistoryService } from "./image-edit-history.service";
import { ImageEditProcessor } from "./image-edit.processor";
import { ImageEditService } from "./image-edit.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: IMAGE_EDIT_QUEUE_NAME }),
    TypeOrmModule.forFeature([ImageEditHistory], "tool"),
  ],
  controllers: [ImageEditController],
  providers: [ImageEditService, ImageEditHistoryService, ImageEditProcessor],
})
export class ImageEditModule {}
