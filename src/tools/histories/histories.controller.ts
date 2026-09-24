import { BadRequestException, Controller, Delete, Get, Param, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { UNIFIED_HISTORY_SOURCES } from "./histories.constants";
import { HistoriesService } from "./histories.service";

@ApiTags("Histories")
@ApiBearerAuth("bearer")
@Controller("tools/histories")
export class HistoriesController {
  constructor(private readonly historiesService: HistoriesService) {}

  @ApiOperation({ summary: "List unified completed histories across Media, Voice, ShortVideo, Whiteboard, Recap" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "page", required: false })
  @ApiQuery({ name: "limit", required: false })
  @ApiQuery({
    name: "source",
    required: false,
    description: `Filter by source: all | ${UNIFIED_HISTORY_SOURCES.join(" | ")}`,
  })
  @Public()
  @Get()
  async list(
    @Query("userId") userId?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("source") source?: string,
  ) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    return this.historiesService.listUnifiedHistories(
      userId,
      Number(page) || 1,
      Number(limit) || undefined,
      source,
    );
  }

  @ApiOperation({ summary: "Soft-delete a completed history item (hidden from Histories, files kept)" })
  @ApiQuery({ name: "userId", required: true })
  @Public()
  @Delete(":source/:id")
  async softDelete(
    @Param("source") source?: string,
    @Param("id") id?: string,
    @Query("userId") userId?: string,
  ) {
    if (!userId?.trim()) {
      throw new BadRequestException("userId is required");
    }
    if (!source?.trim() || !id?.trim()) {
      throw new BadRequestException("source and id are required");
    }
    return this.historiesService.softDeleteHistory(userId, source, id);
  }
}
