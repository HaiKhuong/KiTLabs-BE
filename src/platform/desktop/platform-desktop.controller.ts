import { Controller, Get, Query, Req } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { PlatformDesktopService } from "./platform-desktop.service";

@ApiTags("Platform Desktop")
@Controller("platform/desktop")
export class PlatformDesktopController {
  constructor(private readonly service: PlatformDesktopService) {}

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({ summary: "Get allowed desktop menus by deviceId" })
  @Get("access")
  access(
    @Query("deviceId") deviceId: string | undefined,
    @Query("appVersion") appVersion: string | undefined,
    @Query("hostname") hostname: string | undefined,
    @Req() req: Request,
  ) {
    const forwarded = req.headers["x-forwarded-for"];
    const ip =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ||
      req.ip ||
      undefined;
    return this.service.getAccessByDeviceId(deviceId, { appVersion, ip, hostname });
  }
}
