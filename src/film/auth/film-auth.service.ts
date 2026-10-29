import { BadRequestException, Injectable, Logger, OnModuleInit, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectDataSource } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { randomUUID } from "crypto";
import { SignOptions } from "jsonwebtoken";
import { DataSource } from "typeorm";
import {
  FilmDevice,
  FilmItem,
  FilmUser,
  FilmUserInventory,
  FilmUserRole,
  FilmUserStatus,
  ItemType,
} from "../entities/film.entities";
import { PlatformUser, PlatformUserAuthType, PlatformUserRole } from "../../platform/entities/platform-user.entity";

@Injectable()
export class FilmAuthService implements OnModuleInit {
  private readonly logger = new Logger(FilmAuthService.name);
  constructor(
    @InjectDataSource("film") private readonly db: DataSource,
    @InjectDataSource() private readonly platformDb: DataSource,
    private readonly jwt: JwtService,
  ) { }

  async onModuleInit(): Promise<void> {
    const email = (process.env.FILM_ADMIN_EMAIL || process.env.PLATFORM_ADMIN_EMAIL || "admin@kitlabs.io")
      .trim()
      .toLowerCase();
    const password = process.env.FILM_ADMIN_PASSWORD || process.env.PLATFORM_ADMIN_PASSWORD || "Admin@123456";
    const username = (process.env.FILM_ADMIN_USERNAME || process.env.PLATFORM_ADMIN_USERNAME || "admin").trim();

    try {
      // 1. Bootstrap Admin in Platform DB (kitlabs_platform)
      const platformRepo = this.platformDb.getRepository(PlatformUser);
      let platformUser = await platformRepo
        .createQueryBuilder("u")
        .where("lower(u.userName) = lower(:username) OR lower(u.email) = lower(:email)", { username, email })
        .getOne();

      if (!platformUser) {
        platformUser = platformRepo.create({
          userName: username,
          email,
          passwordHash: await bcrypt.hash(password, 12),
          authType: PlatformUserAuthType.ACCOUNT,
          role: PlatformUserRole.ADMIN,
          isActive: true,
        });
        platformUser = await platformRepo.save(platformUser);
        this.logger.log(`Bootstrapped Platform Admin (${username} / ${email}) in Platform DB`);
      } else if (platformUser.role !== PlatformUserRole.ADMIN) {
        platformUser.role = PlatformUserRole.ADMIN;
        platformUser = await platformRepo.save(platformUser);
        this.logger.log(`Promoted user ${username} to ADMIN in Platform DB`);
      }

      // 2. Ensure mirror entry exists in Film DB (kitlabs_film) so relational queries succeed
      const filmRepo = this.db.getRepository(FilmUser);
      let filmAdmin = await filmRepo.findOne({
        where: [{ id: platformUser.id }, { email: platformUser.email ?? undefined }],
      });
      if (!filmAdmin) {
        filmAdmin = filmRepo.create({
          id: platformUser.id,
          email: platformUser.email,
          username: platformUser.userName,
          passwordHash: platformUser.passwordHash,
          name: process.env.FILM_ADMIN_NAME?.trim() || platformUser.userName || "Admin",
          role: FilmUserRole.ADMIN,
          status: FilmUserStatus.ACTIVE,
          deviceId: null,
          refreshTokenHash: null,
        });
        await filmRepo.save(filmAdmin);
        this.logger.log(`Synchronized Platform Admin mirror into Film DB (kitlabs_film)`);
      } else if (filmAdmin.role !== FilmUserRole.ADMIN) {
        filmAdmin.role = FilmUserRole.ADMIN;
        filmAdmin.status = FilmUserStatus.ACTIVE;
        await filmRepo.save(filmAdmin);
      }
    } catch (error) {
      this.logger.warn(
        `Failed to bootstrap Platform/Film Admin: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  decodeToken(token: string): { sub?: string; role?: string; deviceId?: string } | null {
    try {
      return this.jwt.decode(token) as { sub?: string; role?: string; deviceId?: string } | null;
    } catch {
      return null;
    }
  }

  async createDevice(
    ip: string | null,
    userAgent: string | null,
    deviceToken?: string,
    existingUserId?: string,
  ) {
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
        device.lastIp = ip || device.lastIp;
        if (!device.firstIp && ip) {
          device.firstIp = ip;
        }
        device.userAgent = userAgent || device.userAgent;
        device.lastSeenAt = new Date();
        await manager.save(device);
      }

      let user: FilmUser | null = null;

      // 1. If existingUserId is provided (from authenticated session/token), keep this user
      if (existingUserId) {
        user = await manager.getRepository(FilmUser).findOneBy({ id: existingUserId });
        if (user && user.deviceId !== device.id) {
          // Release device from any old user if currently held
          const otherUser = await manager.getRepository(FilmUser).findOneBy({ deviceId: device.id });
          if (otherUser && otherUser.id !== user.id) {
            otherUser.deviceId = null;
            await manager.save(otherUser);
          }
          user.deviceId = device.id;
        }
      }

      // 2. If no user from existingUserId, retain the user already linked to this device
      if (!user) {
        user = await manager.getRepository(FilmUser).findOneBy({ deviceId: device.id });
      }

      // 3. Only if no user exists at all, create a new guest user
      if (!user) {
        user = await manager.save(
          manager.create(FilmUser, {
            deviceId: device.id,
            username: null,
            email: null,
            passwordHash: null,
            refreshTokenHash: null,
            name: `Đạo Hữu #${device.deviceToken.slice(0, 8)}`,
            role: FilmUserRole.GUEST,
            status: FilmUserStatus.ACTIVE,
          }),
        );
      }

      user.lastActiveAt = new Date();
      await manager.save(user);

      return { device, user };
    });
    return { device: result.device, ...(await this.issue(result.user)) };
  }

  async device(userId: string) {
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    if (!user.deviceId) throw new UnauthorizedException("User has no device");
    return this.db.getRepository(FilmDevice).findOneByOrFail({ id: user.deviceId });
  }

  async adminLogin(identifier: string, password: string) {
    const trimmedId = identifier.trim().toLowerCase();

    // 1. Authenticate against Platform DB (kitlabs_platform)
    try {
      const platformRepo = this.platformDb.getRepository(PlatformUser);
      const platformUser = await platformRepo
        .createQueryBuilder("u")
        .where("lower(u.userName) = :id OR lower(u.email) = :id", { id: trimmedId })
        .getOne();

      if (platformUser) {
        if (platformUser.role !== PlatformUserRole.ADMIN && platformUser.role !== "ADMIN") {
          throw new UnauthorizedException("Tài khoản không có quyền quản trị Platform");
        }
        if (!platformUser.isActive) {
          throw new UnauthorizedException("Tài khoản Platform đã bị vô hiệu hóa");
        }
        if (!platformUser.passwordHash || !(await bcrypt.compare(password, platformUser.passwordHash))) {
          throw new UnauthorizedException("Mật khẩu không chính xác");
        }

        // Sync / update mirror user in Film DB for CMS operations
        const filmRepo = this.db.getRepository(FilmUser);
        let filmUser = await filmRepo.findOne({
          where: [{ id: platformUser.id }, { email: platformUser.email ?? undefined }],
        });

        if (!filmUser) {
          filmUser = filmRepo.create({
            id: platformUser.id,
            email: platformUser.email,
            username: platformUser.userName,
            name: platformUser.userName || "Admin",
            role: FilmUserRole.ADMIN,
            status: FilmUserStatus.ACTIVE,
            lastLoginAt: new Date(),
          });
          await filmRepo.save(filmUser);
        } else {
          filmUser.role = FilmUserRole.ADMIN;
          filmUser.status = FilmUserStatus.ACTIVE;
          filmUser.lastLoginAt = new Date();
          await filmRepo.save(filmUser);
        }

        return this.issue(filmUser);
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(`Error querying platform db for admin login: ${err}`);
    }

    // 2. Fallback: Authenticate against Film DB (kitlabs_film) if not found in Platform DB
    const filmUser = await this.db
      .getRepository(FilmUser)
      .createQueryBuilder("u")
      .addSelect(["u.passwordHash", "u.refreshTokenHash"])
      .where("lower(u.email) = :id OR lower(u.username) = :id", { id: trimmedId })
      .andWhere("u.role IN (:...roles)", { roles: [FilmUserRole.ADMIN, FilmUserRole.MODERATOR] })
      .getOne();

    if (
      !filmUser?.passwordHash ||
      !(await bcrypt.compare(password, filmUser.passwordHash)) ||
      filmUser.status !== FilmUserStatus.ACTIVE
    ) {
      throw new UnauthorizedException("Thông tin đăng nhập không hợp lệ");
    }

    filmUser.lastLoginAt = new Date();
    await this.db.getRepository(FilmUser).save(filmUser);
    return this.issue(filmUser);
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
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    const equippedTitle = await this.db
      .getRepository(FilmUserInventory)
      .createQueryBuilder("inventory")
      .innerJoin(FilmItem, "item", "item.id = inventory.itemId")
      .select("item.assetConfig ->> 'slug'", "currentTitle")
      .where("inventory.userId = :userId", { userId })
      .andWhere("inventory.isEquipped = true")
      .andWhere("item.type = :type", { type: ItemType.TITLE })
      .orderBy("inventory.acquiredAt", "DESC")
      .addOrderBy("inventory.updatedAt", "DESC")
      .limit(1)
      .getRawOne<{ currentTitle: string | null }>();

    return { ...user, currentTitle: equippedTitle?.currentTitle ?? null };
  }

  async updateProfile(userId: string, dto: { name?: string }) {
    const filmRepo = this.db.getRepository(FilmUser);
    const user = await filmRepo.findOneByOrFail({ id: userId });
    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (trimmed.length < 2 || trimmed.length > 50) {
        throw new BadRequestException("Tên phải từ 2 đến 50 ký tự");
      }
      user.name = trimmed;
    }
    await filmRepo.save(user);
    return this.profile(userId);
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
