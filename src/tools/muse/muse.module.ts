import { Module } from "@nestjs/common";

import { MuseController } from "./muse.controller";
import { MuseRunnerService } from "./muse-runner.service";

@Module({
  controllers: [MuseController],
  providers: [MuseRunnerService],
  exports: [MuseRunnerService],
})
export class MuseModule {}
