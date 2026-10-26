import { Injectable, Logger, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectDataSource } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { SignOptions } from "jsonwebtoken";
import { DataSource } from "typeorm";
import { FilmDevice, FilmUser, FilmUserRole, FilmUserStatus } from "../entities/film.entities";

@Injectable()
export class FilmAuthService implements OnModuleInit {
  private readonly logger = new Logger(FilmAuthService.name);
  constructor(
    @InjectDataSource("film") private readonly db: DataSource,
    private readonly jwt: JwtService,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = process.env.FILM_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.FILM_ADMIN_PASSWORD;
    if (!email || !password) {
      if (process.env.NODE_ENV === "production")
        this.logger.error("FILM_ADMIN_EMAIL and FILM_ADMIN_PASSWORD are required to bootstrap Film Admin");
      return;
    }
    try {
      const repo = this.db.getRepository(FilmUser);
      if (await repo.findOne({ where: { email } })) return;
      await repo.save(
        repo.create({
          email,
          username: email,
          passwordHash: await bcrypt.hash(password, 12),
          name: process.env.FILM_ADMIN_NAME?.trim() || "Film Admin",
          role: FilmUserRole.ADMIN,
          status: FilmUserStatus.ACTIVE,
          deviceId: null,
          refreshTokenHash: null,
        }),
      );
    } catch (error) {
      this.logger.warn(
        `Film Admin was not bootstrapped; run Film migrations first: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async createDevice(ip: string | null, userAgent: string | null, deviceToken?: string) {
    const result = await this.db.transaction(async (manager) => {
      const token = deviceToken || randomUUID();
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [token]);

      let device = await manager.getRepository(FilmDevice).findOneBy({ deviceToken: token });
      if (!device) {
        device = await manager.save(
          manager.create(FilmDevice, {
            deviceToken: token,
            firstIp: ip,
            lastIp: ip,
            userAgent,
            lastSeenAt: new Date(),
          }),
        );
      } else {
        Object.assign(device, { lastIp: ip, userAgent, lastSeenAt: new Date() });
        await manager.save(device);
      }

      let user = await manager.getRepository(FilmUser).findOneBy({ deviceId: device.id });
      if (!user) {
        user = await manager.save(
          manager.create(FilmUser, {
            deviceId: device.id,
            username: null,
            email: null,
            passwordHash: null,
            refreshTokenHash: null,
            name: `Guest-${device.deviceToken.slice(0, 8)}`,
            role: FilmUserRole.GUEST,
            status: FilmUserStatus.ACTIVE,
          }),
        );
      }

      return { device, user };
    });
    return { device: result.device, ...(await this.issue(result.user)) };
  }

  async device(userId: string) {
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    if (!user.deviceId) throw new UnauthorizedException("User has no device");
    return this.db.getRepository(FilmDevice).findOneByOrFail({ id: user.deviceId });
  }

  async adminLogin(email: string, password: string) {
    const user = await this.db
      .getRepository(FilmUser)
      .createQueryBuilder("u")
      .addSelect(["u.passwordHash", "u.refreshTokenHash"])
      .where("lower(u.email) = lower(:email)", { email })
      .andWhere("u.role IN (:...roles)", { roles: [FilmUserRole.ADMIN, FilmUserRole.MODERATOR] })
      .getOne();
    if (
      !user?.passwordHash ||
      !(await bcrypt.compare(password, user.passwordHash)) ||
      user.status !== FilmUserStatus.ACTIVE
    )
      throw new UnauthorizedException("Invalid credentials");
    user.lastLoginAt = new Date();
    await this.db.getRepository(FilmUser).save(user);
    return this.issue(user);
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; tokenType: string };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.FILM_JWT_REFRESH_SECRET || "film_refresh_secret_change_me",
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (payload.tokenType !== "refresh") throw new UnauthorizedException("Invalid refresh token");
    const user = await this.db
      .getRepository(FilmUser)
      .createQueryBuilder("u")
      .addSelect("u.refreshTokenHash")
      .where("u.id = :id", { id: payload.sub })
      .getOne();
    if (!user?.refreshTokenHash || !(await bcrypt.compare(refreshToken, user.refreshTokenHash)))
      throw new UnauthorizedException("Invalid refresh token");
    return this.issue(user);
  }

  async logout(userId: string) {
    await this.db.getRepository(FilmUser).update(userId, { refreshTokenHash: null });
    return { loggedOut: true };
  }
  async profile(userId: string) {
    return this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
  }

  private async issue(user: FilmUser) {
    const base = { sub: user.id, deviceId: user.deviceId, role: user.role };
    const accessToken = await this.jwt.signAsync(
      { ...base, tokenType: "access" },
      {
        secret: process.env.FILM_JWT_ACCESS_SECRET || "film_access_secret_change_me",
        expiresIn: (process.env.FILM_JWT_ACCESS_EXPIRES_IN || "15m") as SignOptions["expiresIn"],
      },
    );
    const refreshToken = await this.jwt.signAsync(
      { ...base, tokenType: "refresh" },
      {
        secret: process.env.FILM_JWT_REFRESH_SECRET || "film_refresh_secret_change_me",
        expiresIn: (process.env.FILM_JWT_REFRESH_EXPIRES_IN || "7d") as SignOptions["expiresIn"],
      },
    );
    await this.db.getRepository(FilmUser).update(user.id, { refreshTokenHash: await bcrypt.hash(refreshToken, 10) });
    return { user, accessToken, refreshToken, accessTokenExpiresIn: process.env.FILM_JWT_ACCESS_EXPIRES_IN || "15m" };
  }
}
