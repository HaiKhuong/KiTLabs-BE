import { CallHandler, ExecutionContext, HttpException, HttpStatus, Injectable, NestInterceptor } from "@nestjs/common";
import { createHash } from "crypto";
import { Observable } from "rxjs";

import { AntiSpamService } from "../../anti-spam/anti-spam.service";

@Injectable()
export class AntiSpamInterceptor implements NestInterceptor {
  constructor(private readonly antiSpamService: AntiSpamService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest();
    const method = request.method as string;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return next.handle();
    }

    const path = request.originalUrl ?? request.url;
    if (path.includes("/auth/refresh")) {
      return next.handle();
    }

    const ttlSeconds = Number(process.env.ANTI_SPAM_TTL_SECONDS ?? 6);
    const requestData = {
      userId: request.user?.userId ?? null,
      ip: request.ip ?? null,
      method,
      path,
      body: request.body ?? {},
    };
    const requestKey = createHash("sha256").update(JSON.stringify(requestData)).digest("hex");
    const acquired = await this.antiSpamService.acquireRequestLock(requestKey, ttlSeconds);

    if (!acquired) {
      await this.antiSpamService.saveBlockedRequest({
        requestKey,
        routePath: path,
        userId: request.user?.userId ?? null,
        ipAddress: request.ip ?? null,
        payload: JSON.stringify(request.body ?? {}),
      });
      throw new HttpException("Duplicate request detected", HttpStatus.TOO_MANY_REQUESTS);
    }
    return next.handle();
  }
}
