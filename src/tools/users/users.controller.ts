import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiBody, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CreateUserDto } from "./dto/create-user.dto";
import { UpdateUserDeviceDto } from "./dto/update-user-device.dto";
import { UsersService } from "./users.service";

@ApiTags("Users")
@Controller("tools/users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @ApiOperation({ summary: "Create user" })
  @ApiBody({ type: CreateUserDto })
  @Post()
  async create(@Body() dto: CreateUserDto) {
    return this.usersService.createUser(dto);
  }

  @ApiOperation({ summary: "Get user by id" })
  @ApiParam({ name: "id", description: "User UUID" })
  @Get(":id")
  async getOne(@Param("id") id: string) {
    return this.usersService.findById(id);
  }

  @ApiOperation({ summary: "Update user device info" })
  @ApiParam({ name: "id", description: "User UUID" })
  @ApiBody({ type: UpdateUserDeviceDto })
  @Patch(":id/device")
  async updateDevice(@Param("id") id: string, @Body() dto: UpdateUserDeviceDto) {
    return this.usersService.updateDevice(id, dto);
  }
}
