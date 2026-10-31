import { AuditLog } from "../../audit/entities/audit-log.entity";
import { SpamLog } from "../../anti-spam/spam-log.entity";

export const AUDIT_DB_ENTITIES = [SpamLog, AuditLog];
