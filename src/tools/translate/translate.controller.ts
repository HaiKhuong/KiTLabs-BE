import { Body, Controller, Get, Post, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateService } from "./translate.service";

@ApiTags("Translates")
@ApiBearerAuth("bearer")
@Controller("tools/translates")
export class TranslateController {
  constructor(private readonly translateService: TranslateService) {}

  @ApiOperation({ summary: "Create translate queue job" })
  @ApiBody({ type: CreateTranslateJobDto })
  @Post()
  async enqueue(@CurrentUser() user: { userId: string } | undefined, @Body() dto: CreateTranslateJobDto) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    dto.userId = user.userId;
    return this.translateService.enqueue(dto);
  }

  @ApiOperation({ summary: "Get current user translate history" })
  @Get("history")
  async history(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.translateService.getHistory(user.userId);
  }
}
