import { Controller, Get, Query } from "@nestjs/common";
import { ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { Public } from "../../common/decorators/public.decorator";
import { LogsService } from "./logs.service";
import { UserActionLog } from "./user-action-log.entity";

@ApiTags("Logs")
@Controller("tools/logs")
export class LogsController {
  constructor(
    @InjectRepository(UserActionLog, "tool")
    private readonly logRepository: Repository<UserActionLog>,
    private readonly logsService: LogsService,
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

  @ApiOperation({ summary: "List render logs (one row per render, with config snapshot in data)" })
  @ApiQuery({ name: "userId", required: false })
  @ApiQuery({ name: "feature", required: false })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @Public()
  @Get("renders")
  async listRenders(
    @Query("userId") userId?: string,
    @Query("feature") feature?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const pageNum = Math.max(1, Number(page) || 1);
    const take = Math.min(200, Math.max(1, Number(limit) || 50));
    return this.logsService.listRenderLogs({
      userId,
      feature,
      take,
      skip: (pageNum - 1) * take,
    });
  }
}
