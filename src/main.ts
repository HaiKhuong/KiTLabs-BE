import "reflect-metadata";

import { randomUUID } from "crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, NextFunction, Request, Response, urlencoded } from "express";

import { kitLabsPlatformMiddleware } from "./common/desktop/request-platform";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = (
    process.env.CORS_ORIGIN ??
    "http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,http://localhost:3001,http://127.0.0.1:3001,http://localhost:3000,http://127.0.0.1:3000,http://localhost:3002,http://127.0.0.1:3002"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (
        !origin ||
        corsOrigins.includes(origin) ||
        origin.startsWith("file:") ||
        origin.startsWith("app:")
      ) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    exposedHeaders: ["Accept-Ranges", "Content-Range", "Content-Length", "Content-Type"],
  });
  app.use(kitLabsPlatformMiddleware);
  app.use((req: Request & { requestId?: string }, res: Response, next: NextFunction) => {
    const headerRequestId = req.headers["x-request-id"];
    const requestId = typeof headerRequestId === "string" ? headerRequestId : randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);
    next();
  });
  app.use(json({ limit: process.env.JSON_LIMIT ?? "500mb" }));
  app.use(urlencoded({ limit: process.env.JSON_LIMIT ?? "500mb", extended: true }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );
  app.setGlobalPrefix("api");
  setupSwagger(app);

  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST?.trim() || "0.0.0.0";
  console.log(`Server is running on ${host}:${port}`);
  await app.listen(port, host);
}

function setupSwagger(app: INestApplication): void {
  const isEnabled = (process.env.SWAGGER_ENABLED ?? "true") === "true";
  if (!isEnabled) {
    return;
  }

  const swaggerPath = process.env.SWAGGER_PATH ?? "docs";
  const config = new DocumentBuilder()
    .setTitle("KiTools BE API")
    .setDescription("API documentation for KiTools BE service")
    .setVersion("1.0.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        in: "header",
      },
      "bearer",
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup(`api/${swaggerPath}`, app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });
}

bootstrap();
