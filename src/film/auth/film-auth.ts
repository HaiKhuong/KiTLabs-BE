import { CanActivate, ExecutionContext, Injectable, SetMetadata, createParamDecorator } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { FilmUserRole } from "../entities/film.entities";

export type FilmPrincipal = { userId: string; deviceId: string | null; role: FilmUserRole; tokenType: "access" };
export const FilmCurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest().user as FilmPrincipal | undefined,
);
export const FILM_ROLES = "filmRoles";
export const FilmRoles = (...roles: FilmUserRole[]) => SetMetadata(FILM_ROLES, roles);

@Injectable()
export class FilmJwtGuard extends AuthGuard("film-jwt") {}

@Injectable()
export class FilmRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}
  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<FilmUserRole[]>(FILM_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest().user as FilmPrincipal | undefined;
    return !!user && roles.includes(user.role);
  }
}
