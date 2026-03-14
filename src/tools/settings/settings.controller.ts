import { Body, Controller, Get, Post, Query, UnauthorizedException } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { UpsertSettingDto } from "./dto/upsert-setting.dto";
import { UpsertUserSettingDto } from "./dto/upsert-user-setting.dto";
import { SettingsService } from "./settings.service";

@ApiTags("Settings")
@ApiBearerAuth("bearer")
@Controller("tools/settings")
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @ApiOperation({ summary: "List global settings" })
  @ApiQuery({ name: "type", required: false, description: "Filter by setting type" })
  @Get()
  async list(@Query("type") type?: string) {
    return this.settingsService.listSettings(type);
  }

  @ApiOperation({ summary: "Create or update global setting" })
  @ApiBody({ type: UpsertSettingDto })
  @Post()
  async upsert(@Body() dto: UpsertSettingDto) {
    return this.settingsService.upsertSetting(dto);
  }

  @ApiOperation({ summary: "List current user settings" })
  @Get("user")
  async listUserSettings(@CurrentUser() user: { userId: string } | undefined) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.settingsService.listUserSettings(user.userId);
  }

  @ApiOperation({ summary: "Create or update current user setting" })
  @ApiBody({ type: UpsertUserSettingDto })
  @Post("user")
  async upsertUserSetting(@CurrentUser() user: { userId: string } | undefined, @Body() dto: UpsertUserSettingDto) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    dto.userId = user.userId;
    return this.settingsService.upsertUserSetting(dto);
  }
}
