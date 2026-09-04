import { Module } from "@nestjs/common";

import { YtdlpController } from "./ytdlp.controller";
import { YtdlpService } from "./ytdlp.service";

@Module({
  controllers: [YtdlpController],
  providers: [YtdlpService],
})
export class YtdlpModule {}
