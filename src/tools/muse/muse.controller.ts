import { Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

import { Public } from "../../common/decorators/public.decorator";
import { MuseRunnerService } from "./muse-runner.service";

class SaveMuseCookiesDto {
  @IsString()
  @IsNotEmpty()
  cookieHeader!: string;
}

@ApiTags("Muse")
@ApiBearerAuth("bearer")
@Controller("tools/muse")
export class MuseController {
  constructor(private readonly museRunner: MuseRunnerService) {}

  @ApiOperation({ summary: "Get Muse.ai connection status (DB / secrets / CLI)" })
  @Public()
  @Get("status")
  getStatus() {
    return this.museRunner.getStatus();
  }

  @ApiOperation({ summary: "Save Muse.ai cookies (hatch_sess) encrypted to DB and verify connection" })
  @Public()
  @Post("auth/cookies")
  saveCookies(@Body() dto: SaveMuseCookiesDto) {
    return this.museRunner.saveCookies(dto.cookieHeader);
  }

  @ApiOperation({ summary: "Clear saved Muse.ai cookies from DB" })
  @Public()
  @Delete("auth/cookies")
  clearCookies() {
    return this.museRunner.clearCookies();
  }

  @ApiOperation({ summary: "Export Muse.ai cookies from Chrome via agent-browser and save to DB" })
  @Public()
  @Post("auth/export")
  exportFromBrowser() {
    return this.museRunner.exportFromBrowser();
  }
}
