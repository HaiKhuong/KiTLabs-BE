import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { TypeOrmModule } from "@nestjs/typeorm";
import { join } from "path";

import { AntiSpamModule } from "./anti-spam/anti-spam.module";
import { AppController } from "./app.controller";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { AntiSpamInterceptor } from "./common/interceptors/anti-spam.interceptor";
import { ResponseTransformInterceptor } from "./common/interceptors/response-transform.interceptor";
import { DatabaseModule } from "./database/database.module";
import { AUDIT_DB_ENTITIES } from "./database/entities/audit.entities";
import { MAIN_DB_ENTITIES } from "./database/entities/main.entities";
import { TOOL_DB_ENTITIES } from "./database/entities/tool.entities";
import { AuthModule } from "./tools/auth/auth.module";
import { AppJwtAuthGuard } from "./tools/auth/guards/app-jwt-auth.guard";
import { CreditsModule } from "./tools/credits/credits.module";
import { DownloadsModule } from "./tools/downloads/downloads.module";
import { FilesModule } from "./tools/files/files.module";
import { LogsModule } from "./tools/logs/logs.module";
import { NotificationsModule } from "./tools/notifications/notifications.module";
import { SettingsModule } from "./tools/settings/settings.module";
import { TranslateModule } from "./tools/translate/translate.module";
import { UsersModule } from "./tools/users/users.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      {
        ttl: Number(process.env.RATE_LIMIT_TTL_SECONDS ?? 60) * 1000,
        limit: Number(process.env.RATE_LIMIT_LIMIT ?? 120),
      },
    ]),
    TypeOrmModule.forRoot({
      type: "postgres",
      host: process.env.MAIN_DB_HOST ?? process.env.DB_HOST ?? "localhost",
      port: Number(process.env.MAIN_DB_PORT ?? process.env.DB_PORT ?? 5432),
      username: process.env.MAIN_DB_USER ?? process.env.DB_USER ?? "postgres",
      password: process.env.MAIN_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "postgres",
      database: process.env.MAIN_DB_NAME ?? process.env.DB_NAME ?? "kitools",
      synchronize: false,
      migrationsRun: (process.env.MAIN_DB_MIGRATIONS_RUN ?? "false") === "true",
      autoLoadEntities: false,
      entities: MAIN_DB_ENTITIES,
      migrations: [join(__dirname, "database/migrations/main/*{.ts,.js}")],
    }),
    TypeOrmModule.forRoot({
      name: "tool",
      type: "postgres",
      host: process.env.TOOL_DB_HOST ?? process.env.DB_HOST ?? "localhost",
      port: Number(process.env.TOOL_DB_PORT ?? process.env.DB_PORT ?? 5432),
      username: process.env.TOOL_DB_USER ?? process.env.DB_USER ?? "postgres",
      password: process.env.TOOL_DB_PASSWORD ?? process.env.DB_PASSWORD ?? "postgres",
      database: process.env.TOOL_DB_NAME ?? process.env.DB_NAME ?? "kitools",
      synchronize: false,
      migrationsRun: (process.env.TOOL_DB_MIGRATIONS_RUN ?? "false") === "true",
      autoLoadEntities: false,
      entities: TOOL_DB_ENTITIES,
      migrations: [join(__dirname, "database/migrations/main/*{.ts,.js}")],
    }),
    TypeOrmModule.forRoot({
      name: "audit",
      type: "postgres",
      host: process.env.AUDIT_DB_HOST ?? "localhost",
      port: Number(process.env.AUDIT_DB_PORT ?? 5432),
      username: process.env.AUDIT_DB_USER ?? "postgres",
      password: process.env.AUDIT_DB_PASSWORD ?? "postgres",
      database: process.env.AUDIT_DB_NAME ?? "kitools_audit",
      synchronize: false,
      migrationsRun: (process.env.AUDIT_DB_MIGRATIONS_RUN ?? "false") === "true",
      autoLoadEntities: false,
      entities: AUDIT_DB_ENTITIES,
      migrations: [join(__dirname, "database/migrations/audit/*{.ts,.js}")],
    }),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? "localhost",
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        db: Number(process.env.REDIS_DB ?? 0),
      },
    }),
    UsersModule,
    CreditsModule,
    LogsModule,
    DownloadsModule,
    TranslateModule,
    NotificationsModule,
    SettingsModule,
    AuthModule,
    FilesModule,
    DatabaseModule,
    AntiSpamModule,
  ],
  controllers: [AppController],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AppJwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: AntiSpamInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: ResponseTransformInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule {}
