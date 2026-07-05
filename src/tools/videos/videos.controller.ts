import { BadRequestException, Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteImageDto } from "./dto/execute-image.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import { UpsertVideoWorkflowDto } from "./dto/upsert-video-workflow.dto";
import { VideosJobsService } from "./videos-jobs.service";
import { VideosService } from "./videos.service";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos")
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videosJobsService: VideosJobsService,
  ) {}

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

  @ApiOperation({ summary: "Queue AI Task — kết quả qua socket videos.job.completed / failed" })
  @ApiBody({ type: ExecuteAiTaskDto })
  @Public()
  @Post("ai-task/execute")
  async executeAiTask(@Body() dto: ExecuteAiTaskDto) {
    return this.videosJobsService.submitAiTask(dto);
  }

  @ApiOperation({ summary: "Queue Voice TTS — kết quả qua socket videos.job.completed / failed" })
  @ApiBody({ type: ExecuteVoiceDto })
  @Public()
  @Post("voice/generate")
  async executeVoice(@Body() dto: ExecuteVoiceDto) {
    return this.videosJobsService.submitVoice(dto);
  }

  @ApiOperation({ summary: "Queue Image gen — kết quả qua socket videos.job.completed / failed" })
  @ApiBody({ type: ExecuteImageDto })
  @Public()
  @Post("image/generate")
  async executeImage(@Body() dto: ExecuteImageDto) {
    return this.videosJobsService.submitImage(dto);
  }
}
