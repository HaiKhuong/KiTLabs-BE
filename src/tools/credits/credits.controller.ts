import { Body, Controller, Get, Post, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AdjustCreditDto } from "./dto/adjust-credit.dto";
import { CreditsService } from "./credits.service";

@ApiTags("Credits")
@ApiBearerAuth("bearer")
@Controller("tools/credits")
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @ApiOperation({ summary: "Adjust user credit" })
  @ApiBody({ type: AdjustCreditDto })
  @Post("adjust")
  async adjust(@CurrentUser() user: { userId: string } | undefined, @Body() dto: AdjustCreditDto) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    dto.userId = user.userId;
    return this.creditsService.adjustCredit(dto);
  }

  @ApiOperation({ summary: "Get current user credit history" })
  @Get("history")
  async history(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.creditsService.getUserHistories(user.userId);
  }
}
