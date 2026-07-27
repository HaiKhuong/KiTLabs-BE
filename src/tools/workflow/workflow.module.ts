import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AudioModule } from "../audio/audio.module";
import { ToolsRealtimeModule } from "../realtime/tools-realtime.module";
import { WorkflowAiService } from "./workflow-ai.service";
import { WorkflowController } from "./workflow.controller";
import { WorkflowEntity } from "./workflow.entity";
import { WorkflowImageService } from "./workflow-image.service";
import { WorkflowJobsService } from "./workflow-jobs.service";
import { WorkflowRunEntity } from "./workflow-run.entity";
import { WorkflowRunService } from "./workflow-run.service";
import { WorkflowService } from "./workflow.service";
import { WorkflowVoiceService } from "./workflow-voice.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([WorkflowEntity, WorkflowRunEntity], "tool"),
    AudioModule,
    ToolsRealtimeModule,
  ],
  controllers: [WorkflowController],
  providers: [
    WorkflowService,
    WorkflowRunService,
    WorkflowAiService,
    WorkflowVoiceService,
    WorkflowImageService,
    WorkflowJobsService,
  ],
  exports: [
    WorkflowService,
    WorkflowRunService,
    WorkflowAiService,
    WorkflowVoiceService,
    WorkflowImageService,
    WorkflowJobsService,
  ],
})
export class WorkflowModule {}
