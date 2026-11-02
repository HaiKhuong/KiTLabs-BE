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
import { PlatformAdminService } from "./platform-admin.service";

@ApiTags("Platform Admin - Roles")
@Controller("platform/admin/roles")
export class PlatformAdminRolesController {
  constructor(private readonly service: PlatformAdminService) {}

  @ApiOperation({ summary: "Get list of platform admin roles" })
  @Get()
  list(
    @Query("page") page?: number,
    @Query("limit") limit?: number,
    @Query("deleted") deleted?: string,
    @Query("search") search?: string,
  ) {
    return this.service.listRoles(Number(page) || 1, Number(limit) || 50, {
      deleted,
      search,
    });
  }

  @ApiOperation({ summary: "Get platform admin role details" })
  @Get(":id")
  one(@Param("id") id: string) {
    return this.service.oneRole(id);
  }

  @ApiOperation({ summary: "Create new platform admin role" })
  @Post()
  create(@Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.createRole(data);
  }

  @ApiOperation({ summary: "Update platform admin role" })
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.updateRole(id, data);
  }

  @ApiOperation({ summary: "Soft delete platform admin role" })
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.deleteRole(id);
  }

  @ApiOperation({ summary: "Restore soft deleted platform admin role" })
  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.service.restoreRole(id);
  }
}
