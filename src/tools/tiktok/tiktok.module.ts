import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { PlatformModule } from "../../platform/platform.module";
import { TikTokAccount } from "./tiktok-account.entity";
import { TikTokController, TikTokVideosController } from "./tiktok.controller";
import { TikTokProcessor } from "./tiktok.processor";
import { TikTokProviderAdapter } from "./tiktok-provider.adapter";
import { TIKTOK_PUBLISH_QUEUE, TikTokService } from "./tiktok.service";
import { TikTokVideo } from "./tiktok-video.entity";

@Module({
  imports: [
    BullModule.registerQueue({ name: TIKTOK_PUBLISH_QUEUE }),
    TypeOrmModule.forFeature([TikTokAccount, TikTokVideo], "tool"),
    PlatformModule,
  ],
  controllers: [TikTokController, TikTokVideosController],
  providers: [TikTokService, TikTokProviderAdapter, TikTokProcessor],
  exports: [TikTokService],
})
export class TikTokModule {}

