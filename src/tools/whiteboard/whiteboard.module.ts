import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { WhiteboardController } from "./whiteboard.controller";
import { WhiteboardHistory } from "./whiteboard-history.entity";
import { WhiteboardIdeaHistory } from "./whiteboard-idea-history.entity";
import { WhiteboardIdeasService } from "./whiteboard-ideas.service";
import { WhiteboardProcessor } from "./whiteboard.processor";
import { WhiteboardRendererService } from "./whiteboard-renderer.service";
import { WhiteboardSampleImage } from "./whiteboard-sample-image.entity";
import { WhiteboardSamplesService } from "./whiteboard-samples.service";
import { WHITEBOARD_QUEUE_NAME, WhiteboardService } from "./whiteboard.service";
import { WhiteboardVoiceService } from "./whiteboard-voice.service";

@Module({
  imports: [
    BullModule.registerQueue({ name: WHITEBOARD_QUEUE_NAME }),
    TypeOrmModule.forFeature(
      [WhiteboardHistory, WhiteboardIdeaHistory, WhiteboardSampleImage],
      "tool",
    ),
    ToolsRealtimeModule,
    NotificationsModule,
    AudioModule,
  ],
  controllers: [WhiteboardController],
  providers: [
    WhiteboardService,
    WhiteboardIdeasService,
    WhiteboardSamplesService,
    WhiteboardProcessor,
    WhiteboardRendererService,
    WhiteboardVoiceService,
  ],
  exports: [WhiteboardService],
})
export class WhiteboardModule {}
