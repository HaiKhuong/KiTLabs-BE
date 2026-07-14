import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { WorkflowAiService } from "./workflow-ai.service";
import { WorkflowController } from "./workflow.controller";
import { WorkflowEntity } from "./workflow.entity";
import { WorkflowImageService } from "./workflow-image.service";
import { WorkflowJobsService } from "./workflow-jobs.service";
import { WorkflowService } from "./workflow.service";
import { WorkflowVoiceService } from "./workflow-voice.service";

@Module({
  imports: [TypeOrmModule.forFeature([WorkflowEntity], "tool"), AudioModule, ToolsRealtimeModule],
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    WorkflowAiService,
    WorkflowVoiceService,
    WorkflowImageService,
    WorkflowJobsService,
  ],
  exports: [
    WorkflowService,
    WorkflowAiService,
    WorkflowVoiceService,
    WorkflowImageService,
    WorkflowJobsService,
  ],
})
export class WorkflowModule {}
