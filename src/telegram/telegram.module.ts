import { Global, Module } from "@nestjs/common";
import { PlatformModule } from "../platform/platform.module";
import { TelegramController } from "./telegram.controller";
import { TelegramService } from "./telegram.service";

@Global()
@Module({
  imports: [PlatformModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class PlatformTelegramModule {}
