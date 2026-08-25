import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiQuery, ApiTags } from "@nestjs/swagger";

import { Public } from "../../common/decorators/public.decorator";
import { CreateUserSettingProfileDto } from "./dto/create-user-setting-profile.dto";
import { UpdateUserSettingProfileDto } from "./dto/update-user-setting-profile.dto";
import { UpsertSettingDto } from "./dto/upsert-setting.dto";
import { UpsertUserSettingDto } from "./dto/upsert-user-setting.dto";
import { SettingsService } from "./settings.service";
import { AppConfigService } from "../../common/config/app-config.service";
import { RUNTIME_CODE_SET } from "../../common/config/runtime-settings.catalog";
import { UpsertRuntimeSettingsDto } from "./dto/upsert-runtime-settings.dto";

@ApiTags("Settings")
@ApiBearerAuth("bearer")
@Controller("tools/settings")
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly appConfigService: AppConfigService,
  ) {}

  @Public()
  @ApiOperation({ summary: "List runtime pipeline settings (secrets masked)" })
  @Get("runtime")
  async listRuntime() {
    return this.appConfigService.listRuntime();
  }

  @Public()
  @ApiOperation({ summary: "Upsert runtime pipeline settings" })
  @Put("runtime")
  async upsertRuntime(@Body() dto: UpsertRuntimeSettingsDto) {
    for (const item of dto.items ?? []) {
      if (!RUNTIME_CODE_SET.has(item.code)) {
        throw new BadRequestException(`Unknown runtime setting: ${item.code}`);
      }
      await this.appConfigService.upsertRuntime(item.code, item.value ?? "");
    }
    return this.appConfigService.listRuntime();
  }

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
  @ApiQuery({
    name: "includeDisabled",
    required: false,
    description: "Include soft-disabled profiles (settings management UI)",
  })
  @Public()
  @Get("user/profiles")
  async listUserSettingProfiles(
    @Query("userId") userId?: string,
    @Query("type") type?: string,
    @Query("includeDisabled") includeDisabled?: string,
  ) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    return this.settingsService.listUserSettingProfiles(userId, type, {
      includeDisabled: includeDisabled === "true" || includeDisabled === "1",
    });
  }

  @ApiOperation({ summary: "Create user setting profile" })
  @ApiBody({ type: CreateUserSettingProfileDto })
  @Public()
  @Post("user/profiles")
  async createUserSettingProfile(@Body() dto: CreateUserSettingProfileDto) {
    return this.settingsService.createUserSettingProfile(dto);
  }

  @ApiOperation({ summary: "Update user setting profile" })
  @ApiBody({ type: UpdateUserSettingProfileDto })
  @Public()
  @Put("user/profiles/:id")
  async updateUserSettingProfile(@Param("id") id: string, @Body() dto: UpdateUserSettingProfileDto) {
    return this.settingsService.updateUserSettingProfile(id, dto);
  }

  @ApiOperation({ summary: "Soft-disable user setting profile (can re-enable later)" })
  @ApiQuery({ name: "userId", required: true, description: "User UUID" })
  @Public()
  @Delete("user/profiles/:id")
  async deleteUserSettingProfile(@Param("id") id: string, @Query("userId") userId?: string) {
    if (!userId) {
      throw new BadRequestException("userId is required");
    }
    await this.settingsService.deleteUserSettingProfile(id, userId);
    return { success: true };
  }
}
