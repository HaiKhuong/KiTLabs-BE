import { Body, Controller, Get, Post, UnauthorizedException, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiBody, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { AuthService } from "./auth.service";
import { GuestAuthDto } from "./dto/guest-auth.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { RegisterDto } from "./dto/register.dto";

@ApiTags("Auth")
@Controller("tools/auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @ApiOperation({ summary: "Register new user" })
  @ApiBody({ type: RegisterDto })
  @Public()
  @Post("register")
  async register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @ApiOperation({ summary: "Login and get JWT tokens" })
  @ApiBody({ type: LoginDto })
  @Public()
  @Post("login")
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @ApiOperation({ summary: "Login/Create guest user by device identity and return profile" })
  @ApiBody({ type: GuestAuthDto })
  @Public()
  @Post("guest")
  async guest(@Body() dto: GuestAuthDto) {
    return this.authService.guest(dto);
  }

  @ApiOperation({ summary: "Refresh access token" })
  @ApiBody({ type: RefreshTokenDto })
  @Public()
  @Post("refresh")
  async refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  @ApiBearerAuth("bearer")
  @ApiOperation({ summary: "Logout current user" })
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  async logout(@CurrentUser() user?: { userId: string }) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.authService.logout(user.userId);
  }

  @ApiBearerAuth("bearer")
  @ApiOperation({ summary: "Get current user profile" })
  @UseGuards(JwtAuthGuard)
  @Get("profile")
  async profile(@CurrentUser() user?: { userId: string }) {
    if (!user) {
      throw new UnauthorizedException("Unauthorized");
    }
    return this.authService.getProfile(user.userId);
  }
}
