import { BadRequestException, Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { CreateUserSettingProfileDto } from "./dto/create-user-setting-profile.dto";
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

  @ApiOperation({ summary: "List user settings by userId" })
  @ApiQuery({ name: "userId", required: true, description: "User UUID" })
  @ApiQuery({ name: "type", required: false, description: "Filter by setting type" })
  @ApiQuery({ name: "profileId", required: false, description: "Filter by profile id" })
  @Public()
  @Get("user")
  async listUserSettings(
    @Query("userId") userId?: string,
    @Query("type") type?: string,
    @Query("profileId") profileId?: string,
  ) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.settingsService.listUserSettings(userId, type, profileId);
  }

  @ApiOperation({ summary: "Create or update user settings (single item or list)" })
  @ApiBody({ type: UpsertUserSettingDto, isArray: true })
  @Public()
  @Put("user")
  async upsertUserSetting(@Body() payload: UpsertUserSettingDto | UpsertUserSettingDto[]) {
    return this.settingsService.upsertUserSettings(payload);
  }

  @ApiOperation({ summary: "List user setting profiles by userId" })
  @ApiQuery({ name: "userId", required: true, description: "User UUID" })
  @ApiQuery({ name: "type", required: false, description: "Filter by setting type" })
  @Public()
  @Get("user/profiles")
  async listUserSettingProfiles(@Query("userId") userId?: string, @Query("type") type?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.settingsService.listUserSettingProfiles(userId, type);
  }

  @ApiOperation({ summary: "Create user setting profile" })
  @ApiBody({ type: CreateUserSettingProfileDto })
  @Public()
  @Post("user/profiles")
  async createUserSettingProfile(@Body() dto: CreateUserSettingProfileDto) {
    return this.settingsService.createUserSettingProfile(dto);
  }
}
