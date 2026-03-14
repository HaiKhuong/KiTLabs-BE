import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { RedisService } from "../database/redis.service";
import { SpamLog } from "./spam-log.entity";

@Injectable()
export class AntiSpamService {
  constructor(
    private readonly redisService: RedisService,
    @InjectRepository(SpamLog, "audit")
    private readonly spamLogRepository: Repository<SpamLog>,
  ) {}

  async acquireRequestLock(requestKey: string, ttlSeconds: number): Promise<boolean> {
    return this.redisService.setNx(`antispam:${requestKey}`, "1", ttlSeconds);
  }

  async saveBlockedRequest(input: {
    requestKey: string;
    routePath: string;
    userId?: string | null;
    ipAddress?: string | null;
    payload?: string | null;
  }): Promise<void> {
    await this.spamLogRepository.save(
      this.spamLogRepository.create({
        requestKey: input.requestKey,
        routePath: input.routePath,
        userId: input.userId ?? null,
        ipAddress: input.ipAddress ?? null,
        payload: input.payload ?? null,
      }),
    );
  }
}
