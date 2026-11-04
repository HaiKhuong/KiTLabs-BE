import { Global, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { GoogleSheetsService } from "./google-sheets.service";
import { TelegramController } from "./telegram.controller";
import { TelegramGeminiService } from "./telegram-gemini.service";
import { TelegramService } from "./telegram.service";
import { TelegramUserConfig } from "./telegram-user-config.entity";
import { TelegramUserConfigService } from "./telegram-user-config.service";

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([TelegramUserConfig], "tool")],
  controllers: [TelegramController],
  providers: [
    TelegramService,
    TelegramUserConfigService,
    GoogleSheetsService,
    TelegramGeminiService,
  ],
  exports: [
    TelegramService,
    TelegramUserConfigService,
    GoogleSheetsService,
    TelegramGeminiService,
  ],
})
export class TelegramModule {}
