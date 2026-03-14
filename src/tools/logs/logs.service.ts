import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { UserActionLog } from "./user-action-log.entity";

@Injectable()
export class LogsService {
  constructor(
    @InjectRepository(UserActionLog, "tool")
    private readonly logRepository: Repository<UserActionLog>,
  ) {}

  async createLog(input: {
    userId?: string | null;
    action: string;
    payload?: Record<string, unknown>;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<UserActionLog> {
    const log = this.logRepository.create({
      userId: input.userId ?? null,
      action: input.action,
      payload: input.payload ?? null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    });
    return this.logRepository.save(log);
  }
}
