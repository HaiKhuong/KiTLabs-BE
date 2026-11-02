import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PlatformOAuthStateService } from "./common/platform-oauth-state.service";
import { PlatformAdminGuard } from "./credentials/platform-admin.guard";
import { PlatformCredentialsController } from "./credentials/platform-credentials.controller";
import { PlatformCredentialsService } from "./credentials/platform-credentials.service";
import { PlatformAccount } from "./entities/platform-account.entity";
import { PlatformCredential } from "./entities/platform-credential.entity";
import { PlatformFacebookPage } from "./entities/platform-facebook-page.entity";
import { PlatformAdminRole } from "./entities/platform-admin-role.entity";
import { PlatformAdminUser } from "./entities/platform-admin-user.entity";
import { PlatformAdminService } from "./admin/platform-admin.service";
import { PlatformAdminUsersController } from "./admin/platform-admin-users.controller";
import { PlatformAdminRolesController } from "./admin/platform-admin-roles.controller";
import { FacebookGraphClient } from "./facebook/facebook-graph.client";
import { PlatformFacebookController } from "./facebook/platform-facebook.controller";
import { PlatformFacebookService } from "./facebook/platform-facebook.service";
import { PlatformTikTokController } from "./tiktok/platform-tiktok.controller";
import { PlatformTikTokService } from "./tiktok/platform-tiktok.service";
import { TikTokApiClient } from "./tiktok/tiktok-api.client";

@Module({
  imports: [
    // Registers entities on the DEFAULT / MAIN database connection
    TypeOrmModule.forFeature([
      PlatformCredential,
      PlatformAccount,
      PlatformFacebookPage,
      PlatformAdminRole,
      PlatformAdminUser,
    ]),
  ],
  controllers: [
    PlatformCredentialsController,
    PlatformFacebookController,
    PlatformTikTokController,
    PlatformAdminUsersController,
    PlatformAdminRolesController,
  ],
  providers: [
    PlatformCredentialsService,
    PlatformAdminGuard,
    PlatformOAuthStateService,
    FacebookGraphClient,
    PlatformFacebookService,
    TikTokApiClient,
    PlatformTikTokService,
    PlatformAdminService,
  ],
  exports: [
    PlatformCredentialsService,
    PlatformFacebookService,
    PlatformTikTokService,
    FacebookGraphClient,
    TikTokApiClient,
    PlatformAdminService,
  ],
})
export class PlatformModule {}
