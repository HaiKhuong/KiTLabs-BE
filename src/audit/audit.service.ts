import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { CreateAuditLogDto } from "./dto/create-audit-log.dto";
import { AuditLog } from "./entities/audit-log.entity";

@Injectable()
export class AuditService implements OnModuleInit {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectDataSource("audit") private readonly auditDataSource: DataSource,
    @InjectRepository(AuditLog, "audit")
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  async onModuleInit() {
    try {
      await this.auditDataSource.query(`
        CREATE TABLE IF NOT EXISTS "audit_logs" (
          "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
          "module" character varying(64) NOT NULL,
          "session_id" character varying(128) NOT NULL,
          "event" character varying(64) NOT NULL,
          "object_id" character varying(255),
          "object_name" text,
          "object_type" character varying(64),
          "error_code" character varying(64),
          "error_message" text,
          "page" character varying(255),
          "user_id" character varying(64),
          "device_id" character varying(128),
          "metadata" jsonb,
          "ip_address" character varying(64),
          "user_agent" text,
          "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
          CONSTRAINT "PK_audit_logs_id" PRIMARY KEY ("id")
        )
      `);
      await this.auditDataSource.query(
        `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_module_event" ON "audit_logs" ("module", "event")`,
      );
      await this.auditDataSource.query(
        `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_session_id" ON "audit_logs" ("session_id")`,
      );
      await this.auditDataSource.query(
        `CREATE INDEX IF NOT EXISTS "IDX_audit_logs_created_at" ON "audit_logs" ("created_at")`,
      );
    } catch (error) {
      this.logger.warn(`Failed to auto-verify audit_logs schema: ${(error as Error).message}`);
    }
  }

  async record(
    payload: CreateAuditLogDto | CreateAuditLogDto[],
    ip: string | null,
    userAgent: string | null,
  ) {
    const items = Array.isArray(payload) ? payload : [payload];
    if (items.length === 0) return { success: true, count: 0 };

    const entities = items.map((item) =>
      this.auditRepo.create({
        module: item.module,
        sessionId: item.sessionId,
        event: item.event,
        objectId: item.objectId ?? null,
        objectName: item.objectName ?? null,
        objectType: item.objectType ?? null,
        errorCode: item.errorCode ?? null,
        errorMessage: item.errorMessage ?? null,
        page: item.page ?? null,
        userId: item.userId ?? null,
        deviceId: item.deviceId ?? null,
        metadata: item.metadata ?? null,
        ipAddress: ip,
        userAgent: userAgent,
      }),
    );

    await this.auditRepo.save(entities);
    return { success: true, count: entities.length };
  }
}

