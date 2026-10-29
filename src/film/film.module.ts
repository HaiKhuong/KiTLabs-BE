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

@Module({
  imports: [
    TypeOrmModule.forFeature(FILM_DB_ENTITIES, "film"),
    PassportModule.register({ defaultStrategy: "film-jwt" }),
    JwtModule.register({}),
  ],
  controllers: [
    FilmAuthController,
    FilmCatalogController,
    FilmAccountController,
    FilmChatController,
    FilmTrackingController,
    FilmUploadController,
    ...FILM_CATALOG_ADMIN_CONTROLLERS,
    ...FILM_CONTENT_ADMIN_CONTROLLERS,
    ...FILM_OPERATIONS_ADMIN_CONTROLLERS,
  ],
  providers: [
    FilmAuthService,
    FilmJwtStrategy,
    FilmJwtGuard,
    FilmRolesGuard,
    FilmCatalogService,
    FilmAccountService,
    FilmTrackingService,
    FilmChatService,
    FilmAdminService,
    FilmChatGateway,
  ],
  exports: [
    FilmCatalogService,
    FilmAccountService,
    FilmTrackingService,
    FilmChatService,
    FilmAdminService,
  ],
})
export class FilmModule {}
