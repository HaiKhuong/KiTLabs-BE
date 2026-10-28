import { Body, Controller, Get, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { FilmAuthService } from "../../auth/film-auth.service";

class AdminLoginDto {
  @ApiProperty({ description: "Email or username of admin" })
  @IsString()
  @MinLength(3)
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  password!: string;
}
class RefreshDto {
  @ApiProperty() @IsString() refreshToken!: string;
}
class DeviceDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() deviceToken?: string;
}
export class UpdateFilmProfileDto {
  @ApiPropertyOptional({ description: "Tên hiển thị của người dùng" })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  name?: string;
}

@Public()
@ApiTags("Film Guest - Auth")
@Controller("film/auth")
export class FilmAuthController {
  constructor(private readonly auth: FilmAuthService) {}

  @Post("device")
  createDevice(@Req() req: Request, @Body() dto: DeviceDto) {
    return this.auth.createDevice(req.socket.remoteAddress || null, req.get("user-agent") || null, dto.deviceToken);
  }

  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Get("device")
  device(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.device(user.userId);
  }

  @Post("admin/login")
  login(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto.email, dto.password);
  }

  @Post("refresh")
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Post("logout")
  logout(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.logout(user.userId);
  }

  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Get("profile")
  profile(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.profile(user.userId);
  }

  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Put("profile")
  updateProfile(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: UpdateFilmProfileDto) {
    return this.auth.updateProfile(user.userId, dto);
  }

  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Patch("profile")
  patchProfile(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: UpdateFilmProfileDto) {
    return this.auth.updateProfile(user.userId, dto);
  }
}
