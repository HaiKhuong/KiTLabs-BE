import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { Request } from "express";

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.KITLABS_DESKTOP === "1") {
      throw new NotFoundException("Not found on desktop instance");
    }
    const expected = process.env.PLATFORM_ADMIN_TOKEN?.trim();
    if (!expected) {
      throw new ForbiddenException("Platform admin token is not configured on server");
    }
    const request = context.switchToHttp().getRequest<Request>();
    const provided = String(request.headers["x-platform-admin-token"] ?? "").trim();
    if (!provided) {
      throw new ForbiddenException("Missing x-platform-admin-token header");
    }

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);
    if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
      throw new ForbiddenException("Invalid platform admin token");
    }
    return true;
  }
}

