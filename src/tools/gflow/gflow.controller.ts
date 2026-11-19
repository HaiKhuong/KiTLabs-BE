import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from "class-validator";

import { Public } from "../../common/decorators/public.decorator";
import { GFlowRunnerService } from "./gflow-runner.service";

class ConnectGFlowAccountDto {
  @IsString()
  @IsNotEmpty()
  profileName!: string;
}

class ResetGFlowPoolDto {
  @IsOptional()
  @IsString()
  profileName?: string;

  @IsOptional()
  @IsBoolean()
  clearUsage?: boolean;
}

@ApiTags("GFlow")
@ApiBearerAuth("bearer")
@Controller("tools/gflow")
export class GFlowController {
  constructor(private readonly gflowRunner: GFlowRunnerService) {}

  @ApiOperation({ summary: "Get Google Flow account pool status and accounts list" })
  @Public()
  @Get("accounts")
  getAccounts() {
    return this.gflowRunner.getPoolStatus();
  }

  @ApiOperation({ summary: "Launch Chrome login to connect a Google Flow account profile" })
  @Public()
  @Post("accounts/connect")
  connectAccount(@Body() dto: ConnectGFlowAccountDto) {
    return this.gflowRunner.connectAccount(dto.profileName);
  }

  @ApiOperation({ summary: "Open Chrome with an existing Google Flow profile" })
  @Public()
  @Post("accounts/:profile/open")
  openChrome(@Param("profile") profile: string) {
    return this.gflowRunner.openAccountChrome(profile);
  }

  @ApiOperation({ summary: "Reset quota block & cooldown for one or all Google Flow accounts" })
  @Public()
  @Post("accounts/reset")
  resetAccounts(@Body() dto: ResetGFlowPoolDto) {
    return this.gflowRunner.resetPool(dto.profileName, Boolean(dto.clearUsage));
  }
}
