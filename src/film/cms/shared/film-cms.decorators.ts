import { applyDecorators, UseGuards } from "@nestjs/common";
import { ApiBearerAuth } from "@nestjs/swagger";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmJwtGuard, FilmRoles, FilmRolesGuard } from "../../auth/film-auth";
import { FilmUserRole } from "../../entities/film.entities";

export const FilmCmsAccess = () =>
  applyDecorators(
    Public(),
    ApiBearerAuth("film-bearer"),
    UseGuards(FilmJwtGuard, FilmRolesGuard),
    FilmRoles(FilmUserRole.ADMIN, FilmUserRole.MODERATOR),
  );
