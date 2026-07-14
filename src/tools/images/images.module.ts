import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { NotificationsModule } from "../notifications/notifications.module";
import { WorkflowModule } from "../workflow/workflow.module";
import { ImageHistory } from "./image-history.entity";
import { ImagesController } from "./images.controller";
import { ImagesHistoryService } from "./images-history.service";
import { ImagesJobsService } from "./images-jobs.service";

@Module({
  imports: [
    WorkflowModule,
    NotificationsModule,
    TypeOrmModule.forFeature([ImageHistory], "tool"),
  ],
  controllers: [ImagesController],
  providers: [ImagesJobsService, ImagesHistoryService],
})
export class ImagesModule {}
