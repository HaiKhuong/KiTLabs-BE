import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as bcrypt from "bcrypt";
import { SignOptions } from "jsonwebtoken";

import { LogsService } from "../logs/logs.service";
import { CreateUserDto } from "../users/dto/create-user.dto";
import { User } from "../users/user.entity";
import { UsersService } from "../users/users.service";
import { LoginDto } from "./dto/login.dto";
import { RegisterDto } from "./dto/register.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly logsService: LogsService,
  ) {}

  async register(dto: RegisterDto): Promise<Record<string, unknown>> {
    const user = await this.usersService.createUserInternal(dto as CreateUserDto);
    await this.logsService.createLog({
      userId: user.id,
      action: "auth.register",
      payload: { userName: user.userName },
    });
    return this.generateAuthTokens(user);
  }

  async login(dto: LoginDto): Promise<Record<string, unknown>> {
    const user = await this.usersService.findByUserName(dto.userName);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }
    const valid = await this.usersService.verifyPassword(user, dto.password);
    if (!valid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    await this.logsService.createLog({
      userId: user.id,
      action: "auth.login",
      payload: { userName: user.userName },
      ip: user.ip,
    });
    return this.generateAuthTokens(user);
  }

  async refreshToken(refreshToken: string): Promise<Record<string, unknown>> {
    const payload = await this.verifyRefreshToken(refreshToken);
    const user = await this.usersService.findById(payload.sub);

    if (!user.refreshTokenHash) {
      throw new UnauthorizedException("Refresh token not found");
    }

    const matches = await bcrypt.compare(refreshToken, user.refreshTokenHash);
    if (!matches) {
      throw new UnauthorizedException("Invalid refresh token");
    }
    return this.generateAuthTokens(user);
  }

  async logout(userId: string): Promise<{ loggedOut: true }> {
    await this.usersService.updateRefreshTokenHash(userId, null);
    await this.logsService.createLog({
      userId,
      action: "auth.logout",
    });
    return { loggedOut: true };
  }

  async getProfile(userId: string): Promise<User> {
    return this.usersService.findById(userId);
  }

  private async generateAuthTokens(user: User): Promise<Record<string, unknown>> {
    const accessExpiresIn = (process.env.JWT_ACCESS_EXPIRES_IN ?? "15m") as SignOptions["expiresIn"];
    const refreshExpiresIn = (process.env.JWT_REFRESH_EXPIRES_IN ?? "7d") as SignOptions["expiresIn"];

    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, userName: user.userName },
      {
        secret: process.env.JWT_ACCESS_SECRET ?? "access_secret",
        expiresIn: accessExpiresIn,
      },
    );
    const refreshToken = await this.jwtService.signAsync(
      { sub: user.id, userName: user.userName },
      {
        secret: process.env.JWT_REFRESH_SECRET ?? "refresh_secret",
        expiresIn: refreshExpiresIn,
      },
    );
    const refreshHash = await bcrypt.hash(refreshToken, 10);
    await this.usersService.updateRefreshTokenHash(user.id, refreshHash);

    return {
      user: {
        id: user.id,
        userName: user.userName,
        credit: user.credit,
      },
      accessToken,
      refreshToken,
      accessTokenExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? "15m",
    };
  }

  private async verifyRefreshToken(refreshToken: string): Promise<{ sub: string }> {
    try {
      return await this.jwtService.verifyAsync<{ sub: string }>(refreshToken, {
        secret: process.env.JWT_REFRESH_SECRET ?? "refresh_secret",
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
  }
}
