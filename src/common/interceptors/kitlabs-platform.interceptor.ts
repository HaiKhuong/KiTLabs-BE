import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Request } from "express";
import { Observable } from "rxjs";

import {
  defaultKitLabsPlatform,
  parseKitLabsPlatform,
  runWithKitLabsPlatform,
} from "../desktop/request-platform";

@Injectable()
export class KitLabsPlatformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Request>();
    const platform = parseKitLabsPlatform(req.headers["x-kitlabs-platform"]) ?? defaultKitLabsPlatform();
    return new Observable((subscriber) => {
      const subscription = runWithKitLabsPlatform(platform, () => next.handle().subscribe(subscriber));
      return () => subscription.unsubscribe();
    });
  }
}
