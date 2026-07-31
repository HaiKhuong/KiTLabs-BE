import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { NotificationsModule } from "../notifications/notifications.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { WhiteboardController } from "./whiteboard.controller";
import { WhiteboardHistory } from "./whiteboard-history.entity";
import { WhiteboardIdeaHistory } from "./whiteboard-idea-history.entity";
import { WhiteboardIdeasService } from "./whiteboard-ideas.service";
import { WhiteboardProcessor } from "./whiteboard.processor";
import { WhiteboardRendererService } from "./whiteboard-renderer.service";
import { WHITEBOARD_QUEUE_NAME, WhiteboardService } from "./whiteboard.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: WHITEBOARD_QUEUE_NAME }),
    TypeOrmModule.forFeature([WhiteboardHistory, WhiteboardIdeaHistory], "tool"),
    ToolsRealtimeModule,
    NotificationsModule,
  ],
  controllers: [WhiteboardController],
  providers: [
    WhiteboardService,
    WhiteboardIdeasService,
    WhiteboardProcessor,
    WhiteboardRendererService,
  ],
  exports: [WhiteboardService],
})
export class WhiteboardModule {}
