import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiProperty, ApiPropertyOptional, ApiTags } from "@nestjs/swagger";
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from "class-validator";
import { Request } from "express";
import { Public } from "../../../common/decorators/public.decorator";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "../../auth/film-auth";
import { FilmAuthService } from "../../auth/film-auth.service";

class AdminLoginDto {
  @ApiProperty() @IsEmail() email!: string;
  @ApiProperty() @IsString() @MinLength(8) password!: string;
}
class RefreshDto {
  @ApiProperty() @IsString() refreshToken!: string;
}
class DeviceDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() deviceToken?: string;
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
}
