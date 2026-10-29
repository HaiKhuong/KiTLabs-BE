import { Body, Controller, Get, Patch, Post, Put, Req, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { AdminLoginDto, DeviceDto, RefreshDto, UpdateFilmProfileDto } from "./dto";
import { FilmCurrentUser, FilmJwtGuard, FilmPrincipal } from "./film-auth";
import { FilmAuthService } from "./film-auth.service";

export { AdminLoginDto, DeviceDto, RefreshDto, UpdateFilmProfileDto };

@Public()
@ApiTags("Film - Auth")
@Controller("film/auth")
export class FilmAuthController {
  constructor(private readonly auth: FilmAuthService) {}

  @ApiOperation({ summary: "Create or identify guest device session" })
  @Post("device")
  createDevice(@Req() req: Request, @Body() dto: DeviceDto) {
    const forwarded = req.headers["x-forwarded-for"];
    const headerIp =
      (typeof forwarded === "string"
        ? forwarded.split(",")[0].trim()
        : Array.isArray(forwarded) && forwarded.length > 0
          ? forwarded[0].split(",")[0].trim()
          : null) ||
      (typeof req.headers["x-real-ip"] === "string" ? req.headers["x-real-ip"].trim() : null) ||
      (typeof req.headers["cf-connecting-ip"] === "string" ? req.headers["cf-connecting-ip"].trim() : null);

    const clientIp = dto.ip || headerIp || req.ip || req.socket.remoteAddress || null;
    const userAgent = dto.userAgent || req.get("user-agent") || null;

    let userId = dto.userId;
    const authHeader = req.headers.authorization;
    if (!userId && authHeader && authHeader.startsWith("Bearer ")) {
      const decoded = this.auth.decodeToken(authHeader.slice(7).trim());
      if (decoded?.sub) {
        userId = decoded.sub;
      }
    }

    return this.auth.createDevice(clientIp, userAgent, dto.deviceToken, userId);
  }

  @ApiOperation({ summary: "Get current device info" })
  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Get("device")
  device(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.device(user.userId);
  }

  @ApiOperation({ summary: "Admin login with email and password" })
  @Post("admin/login")
  login(@Body() dto: AdminLoginDto) {
    return this.auth.adminLogin(dto.email, dto.password);
  }

  @ApiOperation({ summary: "Refresh JWT token" })
  @Post("refresh")
  refresh(@Body() dto: RefreshDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @ApiOperation({ summary: "Logout session" })
  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Post("logout")
  logout(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.logout(user.userId);
  }

  @ApiOperation({ summary: "Get user profile" })
  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Get("profile")
  profile(@FilmCurrentUser() user: FilmPrincipal) {
    return this.auth.profile(user.userId);
  }

  @ApiOperation({ summary: "Update user profile" })
  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Put("profile")
  updateProfile(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: UpdateFilmProfileDto) {
    return this.auth.updateProfile(user.userId, dto);
  }

  @ApiOperation({ summary: "Patch user profile" })
  @ApiBearerAuth("film-bearer")
  @UseGuards(FilmJwtGuard)
  @Patch("profile")
  patchProfile(@FilmCurrentUser() user: FilmPrincipal, @Body() dto: UpdateFilmProfileDto) {
    return this.auth.updateProfile(user.userId, dto);
  }
}

