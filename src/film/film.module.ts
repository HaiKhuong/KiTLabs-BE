import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FilmJwtGuard, FilmRolesGuard } from "./auth/film-auth";
import { FilmAuthService } from "./auth/film-auth.service";
import { FilmJwtStrategy } from "./auth/film-jwt.strategy";
import { FILM_CATALOG_ADMIN_CONTROLLERS } from "./cms/catalog/film-catalog-admin.controllers";
import { FILM_CONTENT_ADMIN_CONTROLLERS } from "./cms/content/film-content-admin.controllers";
import { FILM_OPERATIONS_ADMIN_CONTROLLERS } from "./cms/operations/film-operations-admin.controllers";
import { FilmAdminService } from "./cms/shared/film-admin.service";
import { FilmUploadController } from "./cms/upload/film-upload.controller";
import { FILM_DB_ENTITIES } from "./entities/film.entities";
import { FilmChatGateway } from "./film-chat.gateway";
import { FilmAccountController } from "./guest/account/film-account.controller";
import { FilmAccountService } from "./guest/account/film-account.service";
import { FilmAuthController } from "./auth/film-auth.controller";
import { FilmCatalogController } from "./guest/catalog/film-catalog.controller";
import { FilmCatalogService } from "./guest/catalog/film-catalog.service";
import { FilmChatController } from "./guest/chat/film-chat.controller";
import { FilmChatService } from "./guest/chat/film-chat.service";
import { FilmTrackingController } from "./guest/tracking/film-tracking.controller";
import { FilmTrackingService } from "./guest/tracking/film-tracking.service";
import { DatabaseModule } from "../database/database.module";
import { FilmMissionController } from "./guest/mission/film-mission.controller";
import { FilmMissionService } from "./guest/mission/film-mission.service";
import { FilmFacebookIntegrationController } from "./integration/film-facebook-integration.controller";
import { FilmFacebookIntegrationService } from "./integration/film-facebook-integration.service";
import { FilmAnalyticsAdminController } from "./cms/analytics/film-analytics-admin.controller";
import { FilmAnalyticsAdminService } from "./cms/analytics/film-analytics-admin.service";
import { FilmAnalyticsScannerService } from "./cms/analytics/film-analytics-scanner.service";

@Module({
  imports: [
    DatabaseModule,
    TypeOrmModule.forFeature(FILM_DB_ENTITIES, "film"),
    PassportModule.register({ defaultStrategy: "film-jwt" }),
    JwtModule.register({}),
  ],
  controllers: [
    FilmAuthController,
    FilmMissionController,
    FilmCatalogController,
    FilmAccountController,
    FilmChatController,
    FilmTrackingController,
    FilmUploadController,
    FilmFacebookIntegrationController,
    FilmAnalyticsAdminController,
    ...FILM_CATALOG_ADMIN_CONTROLLERS,
    ...FILM_CONTENT_ADMIN_CONTROLLERS,
    ...FILM_OPERATIONS_ADMIN_CONTROLLERS,
  ],
  providers: [
    FilmAuthService,
    FilmMissionService,
    FilmJwtStrategy,
    FilmJwtGuard,
    FilmRolesGuard,
    FilmCatalogService,
    FilmAccountService,
    FilmTrackingService,
    FilmChatService,
    FilmAdminService,
    FilmAnalyticsScannerService,
    FilmAnalyticsAdminService,
    FilmChatGateway,
    FilmFacebookIntegrationService,
  ],
  exports: [
    FilmCatalogService,
    FilmMissionService,
    FilmAccountService,
    FilmTrackingService,
    FilmChatService,
    FilmAdminService,
    FilmAnalyticsScannerService,
    FilmAnalyticsAdminService,
  ],
})
export class FilmModule {}
