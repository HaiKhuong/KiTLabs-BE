import { Module } from "@nestjs/common";

import { GFlowController } from "./gflow.controller";
import { GFlowRunnerService } from "./gflow-runner.service";

@Module({
  controllers: [GFlowController],
  providers: [GFlowRunnerService],
  exports: [GFlowRunnerService],
})
export class GFlowModule {}
