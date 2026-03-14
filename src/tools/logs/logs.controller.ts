import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { UserActionLog } from "./user-action-log.entity";

@ApiTags("Logs")
@Controller("tools/logs")
export class LogsController {
  constructor(
    @InjectRepository(UserActionLog, "tool")
    private readonly logRepository: Repository<UserActionLog>,
  ) {}

  @ApiOperation({ summary: "List action logs" })
  @ApiQuery({ name: "userId", required: false, description: "Filter logs by user id" })
  @Get()
  async list(@Query("userId") userId?: string): Promise<UserActionLog[]> {
    if (userId) {
      return this.logRepository.find({
        where: { userId },
        order: { createdAt: "DESC" },
        take: 100,
      });
    }
    return this.logRepository.find({ order: { createdAt: "DESC" }, take: 100 });
  }
}
