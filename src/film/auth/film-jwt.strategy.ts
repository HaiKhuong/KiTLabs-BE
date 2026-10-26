import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { FilmPrincipal } from "./film-auth";

@Injectable()
export class FilmJwtStrategy extends PassportStrategy(Strategy, "film-jwt") {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.FILM_JWT_ACCESS_SECRET || "film_access_secret_change_me",
    });
  }
  validate(payload: FilmPrincipal & { sub: string }): FilmPrincipal {
    if (payload.tokenType !== "access" || !payload.sub || !payload.role)
      throw new UnauthorizedException("Invalid film token");
    return { userId: payload.sub, deviceId: payload.deviceId ?? null, role: payload.role, tokenType: "access" };
  }
}
