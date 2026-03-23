import "reflect-metadata";

import { randomUUID } from "crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { json, NextFunction, Request, Response, urlencoded } from "express";

import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = (process.env.CORS_ORIGIN ?? "http://localhost:5173,http://localhost:4173,http://localhost:3001")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });
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
  await app.listen(port);
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
