import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { PlatformAdminAccess } from "../credentials/platform-admin-access.decorator";
import { PlatformDesktopService } from "../desktop/platform-desktop.service";

@PlatformAdminAccess()
@ApiTags("Platform Admin - Desktop Devices")
@Controller("platform/admin/desktop-devices")
export class PlatformAdminDesktopDevicesController {
  constructor(private readonly service: PlatformDesktopService) {}

  @ApiOperation({ summary: "Get desktop menu catalog" })
  @Get("catalog")
  catalog() {
    return this.service.getCatalog();
  }

  @ApiOperation({ summary: "Get discovered desktop devices not yet configured" })
  @Get("discovered")
  discovered() {
    return this.service.listDiscoveredDevices();
  }

  @ApiOperation({ summary: "Get paginated list of desktop devices" })
  @Get()
  list(
    @Query("page") page?: number,
    @Query("limit") limit?: number,
    @Query("deleted") deleted?: string,
    @Query("search") search?: string,
    @Query("isActive") isActive?: string,
  ) {
    return this.service.listDevices(Number(page) || 1, Number(limit) || 20, {
      deleted,
      search,
      isActive,
    });
  }

  @ApiOperation({ summary: "Get desktop device details" })
  @Get(":id")
  one(@Param("id") id: string) {
    return this.service.getDevice(id);
  }

  @ApiOperation({ summary: "Create desktop device rule" })
  @Post()
  create(@Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.createDevice(data);
  }

  @ApiOperation({ summary: "Update desktop device rule" })
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.updateDevice(id, data);
  }

  @ApiOperation({ summary: "Soft delete desktop device" })
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.deleteDevice(id);
  }

  @ApiOperation({ summary: "Restore soft deleted desktop device" })
  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.service.restoreDevice(id);
  }
}
