import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { DownloadModelsDto } from "./dto/download-models.dto";
import { ModelsService } from "./models.service";

@ApiTags("Models")
@ApiBearerAuth("bearer")
@Controller("tools/models")
export class ModelsController {
  constructor(private readonly modelsService: ModelsService) {}

  @Public()
  @Get("status")
  @ApiOperation({ summary: "Local HuggingFace model install status" })
  status() {
    return this.modelsService.status();
  }

  @Public()
  @Post("download")
  @ApiOperation({ summary: "Download selected HF models into KITLABS_PYTHON_CACHE_DIR" })
  download(@Body() dto: DownloadModelsDto) {
    return this.modelsService.download(dto.ids ?? [], dto.userId);
  }
}
