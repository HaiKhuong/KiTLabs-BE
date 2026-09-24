import { Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { RenderLog } from "./render-log.entity";
import { asRenderData } from "./sanitize-render-data";
import { UserActionLog } from "./user-action-log.entity";

export type RenderLogInput = {
  userId?: string | null;
  feature: string;
  historyId?: string | null;
  displayName?: string | null;
  data: unknown;
};

@Injectable()
export class LogsService {
  private readonly logger = new Logger(LogsService.name);

  constructor(
    @InjectRepository(UserActionLog, "tool")
    private readonly logRepository: Repository<UserActionLog>,
    @InjectRepository(RenderLog, "tool")
    private readonly renderLogRepository: Repository<RenderLog>,
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

  /** One row per render attempt. Never throws — logging must not block the job. */
  async logRender(input: RenderLogInput): Promise<void> {
    try {
      const userId = input.userId?.trim() || null;
      await this.renderLogRepository.save(
        this.renderLogRepository.create({
          userId,
          feature: input.feature.trim() || "unknown",
          historyId: input.historyId?.trim() || null,
          displayName: input.displayName?.trim() || null,
          data: asRenderData(input.data),
        }),
      );
    } catch (error) {
      this.logger.warn(`Failed to write render_logs: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async listRenderLogs(opts: {
    userId?: string;
    feature?: string;
    take?: number;
    skip?: number;
  }): Promise<{ items: RenderLog[]; total: number }> {
    const take = Math.min(200, Math.max(1, opts.take ?? 50));
    const skip = Math.max(0, opts.skip ?? 0);
    const qb = this.renderLogRepository.createQueryBuilder("log").orderBy("log.createdAt", "DESC");
    if (opts.userId?.trim()) {
      qb.andWhere("log.user_id = :userId", { userId: opts.userId.trim() });
    }
    if (opts.feature?.trim()) {
      qb.andWhere("log.feature = :feature", { feature: opts.feature.trim() });
    }
    const [items, total] = await qb.take(take).skip(skip).getManyAndCount();
    return { items, total };
  }
}
