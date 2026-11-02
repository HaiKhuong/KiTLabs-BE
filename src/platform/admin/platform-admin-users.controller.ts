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

@ApiTags("Platform Admin - Users")
@Controller("platform/admin/admin-users")
export class PlatformAdminUsersController {
  constructor(private readonly service: PlatformAdminService) {}

  @ApiOperation({ summary: "Get paginated list of platform admin users" })
  @Get()
  list(
    @Query("page") page?: number,
    @Query("limit") limit?: number,
    @Query("deleted") deleted?: string,
    @Query("search") search?: string,
    @Query("roleId") roleId?: string,
  ) {
    return this.service.listUsers(Number(page) || 1, Number(limit) || 20, {
      deleted,
      search,
      roleId,
    });
  }

  @ApiOperation({ summary: "Get platform admin user details" })
  @Get(":id")
  one(@Param("id") id: string) {
    return this.service.oneUser(id);
  }

  @ApiOperation({ summary: "Create new platform admin user" })
  @Post()
  create(@Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.createUser(data);
  }

  @ApiOperation({ summary: "Update platform admin user" })
  @Patch(":id")
  update(@Param("id") id: string, @Body() body: Record<string, any>) {
    const data = (body.data || body) as Record<string, any>;
    return this.service.updateUser(id, data);
  }

  @ApiOperation({ summary: "Soft delete platform admin user" })
  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.service.deleteUser(id);
  }

  @ApiOperation({ summary: "Restore soft deleted platform admin user" })
  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.service.restoreUser(id);
  }
}
