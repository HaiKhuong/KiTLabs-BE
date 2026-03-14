import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { map, Observable } from "rxjs";

type RequestWithId = {
  requestId?: string;
};

@Injectable()
export class ResponseTransformInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithId>();
    return next.handle().pipe(
      map((data) => ({
        success: true,
        data,
        meta: {
          requestId: req.requestId ?? null,
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
