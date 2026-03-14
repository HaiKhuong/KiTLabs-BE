import { Body, Controller, Get, Post, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { CreateDownloadDto } from "./dto/create-download.dto";
import { DownloadsService } from "./downloads.service";

@ApiTags("Downloads")
@ApiBearerAuth("bearer")
@Controller("tools/downloads")
export class DownloadsController {
  constructor(private readonly downloadsService: DownloadsService) {}

  @ApiOperation({ summary: "Create download history from source" })
  @ApiBody({ type: CreateDownloadDto })
  @Post()
  async create(@CurrentUser() user: { userId: string } | undefined, @Body() dto: CreateDownloadDto) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    dto.userId = user.userId;
    return this.downloadsService.create(dto);
  }

  @ApiOperation({ summary: "Get current user download history" })
  @Get("history")
  async getHistory(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.downloadsService.histories(user.userId);
  }
}
