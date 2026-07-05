import { BadRequestException, Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { ExecuteAiTaskDto } from "./dto/execute-ai-task.dto";
import { ExecuteVoiceDto } from "./dto/execute-voice.dto";
import { UpsertVideoWorkflowDto } from "./dto/upsert-video-workflow.dto";
import { VideosAiService } from "./videos-ai.service";
import { VideosService } from "./videos.service";
import { VideosVoiceService } from "./videos-voice.service";

@ApiTags("Videos")
@ApiBearerAuth("bearer")
@Controller("tools/videos")
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly videosAiService: VideosAiService,
    private readonly videosVoiceService: VideosVoiceService,
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

  @ApiOperation({ summary: "Execute AI Task (script + prompt → JSON result)" })
  @ApiBody({ type: ExecuteAiTaskDto })
  @Public()
  @Post("ai-task/execute")
  async executeAiTask(@Body() dto: ExecuteAiTaskDto) {
    return this.videosAiService.executeAiTask(dto);
  }

  @ApiOperation({ summary: "Generate voice segments from scenes JSON (OmniVoice TTS)" })
  @ApiBody({ type: ExecuteVoiceDto })
  @Public()
  @Post("voice/generate")
  async executeVoice(@Body() dto: ExecuteVoiceDto) {
    return this.videosVoiceService.executeVoice(dto);
  }
}
