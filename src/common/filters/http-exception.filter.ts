import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Request, Response } from "express";

type RequestWithId = Request & {
  requestId?: string;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<RequestWithId>();

    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : null;

    let message = "Internal server error";
    if (typeof exceptionResponse === "string") {
      message = exceptionResponse;
    } else if (exceptionResponse && typeof exceptionResponse === "object" && "message" in exceptionResponse) {
      message = Array.isArray(exceptionResponse.message)
        ? exceptionResponse.message[0]
        : String(exceptionResponse.message);
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      success: false,
      error: {
        code: status,
        message,
      },
      meta: {
        requestId: request.requestId ?? null,
        path: request.originalUrl ?? request.url,
        timestamp: new Date().toISOString(),
      },
    });
  }
}
