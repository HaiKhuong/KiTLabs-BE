import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../common/decorators/public.decorator";
import { PlatformAdminGuard } from "./platform-admin.guard";
import { PlatformCredentialsService } from "./platform-credentials.service";

@ApiTags("Platform Credentials")
@Controller("platform/credentials")
export class PlatformCredentialsController {
  constructor(private readonly service: PlatformCredentialsService) {}

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Get()
  list() {
    return this.service.list();
  }

  @Public()
  @UseGuards(PlatformAdminGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put()
  async update(@Body() body: { items: Array<{ code: string; value?: string; clear?: boolean }> }) {
    await this.service.upsert(body.items || []);
    return this.service.list();
  }
}

