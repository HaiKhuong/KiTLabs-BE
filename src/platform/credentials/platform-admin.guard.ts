import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { timingSafeEqual } from "crypto";
import { Request } from "express";
import * as jwt from "jsonwebtoken";

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.KITLABS_DESKTOP === "1") {
      throw new NotFoundException("Not found on desktop instance");
    }

    const request = context.switchToHttp().getRequest<Request>();

    // 1. Check custom platform admin token header
    const expected = process.env.PLATFORM_ADMIN_TOKEN?.trim();
    const provided = String(request.headers["x-platform-admin-token"] ?? "").trim();
    if (expected && provided) {
      const expectedBuf = Buffer.from(expected);
      const providedBuf = Buffer.from(provided);
      if (expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf)) {
        return true;
      }
    }

    // 2. Check Bearer JWT token from Admin Portal (film-jwt)
    const authHeader = String(request.headers["authorization"] ?? "").trim();
    if (authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice(7).trim();
      const secret = process.env.FILM_JWT_ACCESS_SECRET || "film_access_secret_change_me";
      try {
        const decoded = jwt.verify(token, secret) as any;
        const role = String(decoded?.role ?? "").toUpperCase();
        if (role === "ADMIN" || role === "SUPER_ADMIN") {
          return true;
        }
      } catch {
        // Invalid or expired token
      }
    }

    throw new ForbiddenException("Yêu cầu quyền quản trị viên (Admin) hoặc x-platform-admin-token hợp lệ");
  }
}
