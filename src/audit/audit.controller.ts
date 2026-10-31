import { Body, Controller, Post, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../common/decorators/public.decorator";
import { AuditService } from "./audit.service";
import { CreateAuditLogDto } from "./dto/create-audit-log.dto";

@Public()
@ApiTags("Audit - Logging")
@Controller("audit")
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @ApiOperation({ summary: "Ingest client audit log events via sendBeacon or fetch" })
  @Post("log")
  async log(
    @Body() payload: CreateAuditLogDto | CreateAuditLogDto[],
    @Req() req: Request,
  ) {
    const forwarded = req.headers["x-forwarded-for"];
    const ip =
      (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) ||
      (req.socket.remoteAddress ?? null);
    const userAgent = req.get("user-agent") ?? null;

    return this.auditService.record(payload, ip, userAgent);
  }
}

