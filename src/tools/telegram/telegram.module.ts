import { Global, Module } from "@nestjs/common";

import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";

@Global()
@Module({
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}

