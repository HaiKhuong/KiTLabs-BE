import { BadRequestException, Body, Controller, Get, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { UpsertVideoWorkflowDto } from "./dto/upsert-video-workflow.dto";
import { VideosService } from "./videos.service";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos")
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @ApiOperation({ summary: "Get video workflow by userId" })
  @ApiQuery({ name: "userId", required: true })
  @ApiQuery({ name: "name", required: false })
  @Public()
  @Get("workflows")
  async getWorkflow(@Query("userId") userId?: string, @Query("name") name?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.videosService.getByUser(userId, name || "default");
  }

  @ApiOperation({ summary: "Create or update video workflow" })
  @ApiBody({ type: UpsertVideoWorkflowDto })
  @Public()
  @Put("workflows")
  async upsertWorkflow(@Body() dto: UpsertVideoWorkflowDto) {
    return this.videosService.upsert(dto);
  }
}
