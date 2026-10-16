import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FacebookAccount } from "./facebook-account.entity";
import { FacebookAffiliateLink } from "./facebook-affiliate-link.entity";
import { FacebookCommentSettings } from "./facebook-comment-settings.entity";
import { FacebookController } from "./facebook.controller";
import { FacebookOAuthStateService } from "./facebook-oauth-state.service";
import { FacebookPage } from "./facebook-page.entity";
import { FacebookPost } from "./facebook-post.entity";
import { FacebookProcessor } from "./facebook.processor";
import { FacebookProviderAdapter } from "./facebook-provider.adapter";
import { FacebookPublishRunner } from "./facebook-publish.runner";
import { FacebookService } from "./facebook.service";
import { FACEBOOK_PUBLISH_QUEUE } from "./facebook.types";
import { FacebookTaskLog } from "./facebook-task-log.entity";

@Module({
  imports: [
    BullModule.registerQueue({ name: FACEBOOK_PUBLISH_QUEUE }),
    TypeOrmModule.forFeature(
      [FacebookAccount, FacebookPage, FacebookPost, FacebookAffiliateLink, FacebookCommentSettings, FacebookTaskLog],
      "tool",
    ),
  ],
  controllers: [FacebookController],
  providers: [FacebookService, FacebookProviderAdapter, FacebookOAuthStateService, FacebookPublishRunner, FacebookProcessor],
})
export class FacebookModule {}
