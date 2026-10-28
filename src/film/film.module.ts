import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { TypeOrmModule } from "@nestjs/typeorm";
import { FilmJwtGuard, FilmRolesGuard } from "./auth/film-auth";
import { FilmAuthService } from "./auth/film-auth.service";
import { FilmJwtStrategy } from "./auth/film-jwt.strategy";
import { FILM_DB_ENTITIES } from "./entities/film.entities";
import { FilmChatGateway } from "./film-chat.gateway";
import { FilmService } from "./film.service";
import { FILM_CATALOG_ADMIN_CONTROLLERS } from "./cms/catalog/film-catalog-admin.controllers";
import { FILM_CONTENT_ADMIN_CONTROLLERS } from "./cms/content/film-content-admin.controllers";
import { FILM_OPERATIONS_ADMIN_CONTROLLERS } from "./cms/operations/film-operations-admin.controllers";
import { FilmUploadController } from "./cms/upload/film-upload.controller";
import { FilmAccountController } from "./guest/account/film-account.controller";
import { FilmAuthController } from "./guest/auth/film-auth.controller";
import { FilmCatalogController } from "./guest/catalog/film-catalog.controller";
import { FilmChatController } from "./guest/chat/film-chat.controller";
import { FilmTrackingController } from "./guest/tracking/film-tracking.controller";

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
  providers: [FilmAuthService, FilmJwtStrategy, FilmJwtGuard, FilmRolesGuard, FilmService, FilmChatGateway],
})
export class FilmModule {}
