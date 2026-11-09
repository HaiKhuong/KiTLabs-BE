import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { InjectDataSource } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { randomInt, randomUUID } from "crypto";
import { SignOptions } from "jsonwebtoken";
import { DataSource, EntityManager } from "typeorm";
import {
  FilmDevice,
  FilmItem,
  FilmUser,
  FilmUserInventory,
  FilmUserRole,
  FilmUserStatus,
  ItemType,
} from "../entities/film.entities";
import { FilmPrincipal } from "./film-auth";
import { PlatformUser, PlatformUserRole } from "../../platform/entities/platform-user.entity";
import { PlatformAdminUser } from "../../platform/entities/platform-admin-user.entity";
import { PlatformAdminRole } from "../../platform/entities/platform-admin-role.entity";
import { FilmMissionService } from "../guest/mission/film-mission.service";
import { buildCultivationProgress, resolveCultivationRanks } from "../shared/film-rank.util";

const DEFAULT_USER_TITLE = "luyen_khi_ky";

const RESERVED_FILM_NAMES = new Set([
  "admin", "administrator", "mod", "moderator", "sysadmin", "system", "root",
  "support", "helpdesk", "dev", "developer", "tester", "owner", "master",
  "founder", "monitor", "supervisor", "operator", "bot", "quantri",
  "quantrivien", "banquantri", "bodoi", "hotro", "nhanvien",
]);

const normalizeProtectedName = (name: string): string =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const BOT_OR_PROBE_REGEX =
  /^(node|curl|wget|python|axios|go-http-client|undici|postman|insomnia|healthcheck|kube-probe|uptime)|bot|crawler|spider|headless|lighthouse|prerender|facebookexternalhit|bytespider|ahrefs|semrush|mj12bot|dotbot|petalbot|yandex|baiduspider|bingpreview|slurp|duckduckbot/i;

const VALID_OS_REGEX = /windows|android|iphone|ipad|ipod|macintosh|mac os x|linux|cros/i;
const VALID_BROWSER_REGEX =
  /edg|chrome|crios|firefox|fxios|safari|opr|opera|samsungbrowser|ucbrowser|coccoc|brave/i;

@Injectable()
export class FilmAuthService implements OnModuleInit {
  private readonly logger = new Logger(FilmAuthService.name);
  constructor(
    @InjectDataSource("film") private readonly db: DataSource,
    @InjectDataSource() private readonly platformDb: DataSource,
    private readonly jwt: JwtService,
    private readonly missionService: FilmMissionService,
  ) { }

  async onModuleInit(): Promise<void> {
    const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.ADMIN_PASSWORD;
    const fullName = process.env.ADMIN_NAME?.trim() || "Platform Admin";
    if (!email || !password) {
      this.logger.log("Skip Platform Admin bootstrap: ADMIN_EMAIL or ADMIN_PASSWORD is not configured");
      return;
    }
    const username = email.split("@")[0].replace(/[^a-z0-9._-]/gi, "") || "admin";

    try {
      // 1. Bootstrap the configured account in platform_admin_users.
      const adminRepo = this.platformDb.getRepository(PlatformAdminUser);
      const superAdminRole = await this.platformDb
        .getRepository(PlatformAdminRole)
        .findOne({ where: { code: "SUPER_ADMIN" } });
      let platformAdmin = await adminRepo
        .createQueryBuilder("u")
        .where("lower(u.userName) = lower(:username) OR lower(u.email) = lower(:email)", { username, email })
        .getOne();

      if (!platformAdmin) {
        platformAdmin = adminRepo.create({
          userName: username,
          email,
          passwordHash: await bcrypt.hash(password, 12),
          fullName,
          phone: null,
          avatarUrl: null,
          roleId: superAdminRole?.id || null,
          isSuperAdmin: true,
          isActive: true,
          lastLoginAt: null,
          refreshTokenHash: null,
        });
        platformAdmin = await adminRepo.save(platformAdmin);
        this.logger.log(`Bootstrapped Platform Admin (${username} / ${email}) in Platform DB`);
      } else {
        platformAdmin.email = email;
        platformAdmin.fullName = fullName;
        platformAdmin.passwordHash = await bcrypt.hash(password, 12);
        platformAdmin.roleId = superAdminRole?.id || platformAdmin.roleId;
        platformAdmin.isSuperAdmin = true;
        platformAdmin.isActive = true;
        platformAdmin = await adminRepo.save(platformAdmin);
      }

      // 2. Ensure mirror entry exists in Film DB (kitlabs_film) so relational queries succeed
      const filmRepo = this.db.getRepository(FilmUser);
      let filmAdmin = await filmRepo.findOne({
        where: [{ id: platformAdmin.id }, { email: platformAdmin.email }],
      });
      if (!filmAdmin) {
        filmAdmin = filmRepo.create({
          id: platformAdmin.id,
          email: platformAdmin.email,
          username: platformAdmin.userName,
          passwordHash: null,
          name: fullName,
          role: FilmUserRole.ADMIN,
          status: FilmUserStatus.ACTIVE,
          deviceId: null,
          refreshTokenHash: null,
        });
        await filmRepo.save(filmAdmin);
        this.logger.log("Synchronized Platform Admin mirror into Film DB (kitlabs_film)");
      } else {
        filmAdmin.name = fullName;
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

  private normalizeAndValidateDevice(
    ip: string | null,
    userAgent: string | null,
  ): { cleanIp: string; cleanUserAgent: string } {
    const rawIp = (ip || "").trim().toLowerCase();
    const cleanIp = rawIp.startsWith("::ffff:") ? rawIp.slice(7) : rawIp;

    if (
      !cleanIp ||
      cleanIp === "127.0.0.1" ||
      cleanIp === "::1" ||
      cleanIp === "localhost" ||
      cleanIp === "0.0.0.0" ||
      cleanIp.startsWith("127.")
    ) {
      throw new BadRequestException(
        "Từ chối khởi tạo thiết bị từ IP nội bộ (127.0.0.1) hoặc thiếu địa chỉ IP.",
      );
    }

    const cleanUserAgent = (userAgent || "").trim();
    if (!cleanUserAgent || cleanUserAgent.length < 15 || !cleanUserAgent.includes("Mozilla/")) {
      throw new BadRequestException(
        "Từ chối khởi tạo thiết bị do thiếu thông tin thiết bị (User-Agent).",
      );
    }

    if (
      BOT_OR_PROBE_REGEX.test(cleanUserAgent) ||
      !VALID_OS_REGEX.test(cleanUserAgent) ||
      !VALID_BROWSER_REGEX.test(cleanUserAgent)
    ) {
      throw new BadRequestException(
        "Từ chối khởi tạo thiết bị do thông tin hệ điều hành/trình duyệt không hợp lệ.",
      );
    }

    return { cleanIp, cleanUserAgent };
  }

  async createDevice(
    ip: string | null,
    userAgent: string | null,
    deviceToken?: string,
    existingUserId?: string,
    ref?: string,
    isIncognito?: boolean | null,
    incognitoBrowser?: string | null,
  ) {
    const { cleanIp, cleanUserAgent } = this.normalizeAndValidateDevice(ip, userAgent);

    const result = await this.db.transaction(async (manager) => {
      const token = deviceToken || randomUUID();
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [token]);

      let device = await manager.getRepository(FilmDevice).findOneBy({ deviceToken: token });
      if (!device) {
        device = await manager.save(
          manager.create(FilmDevice, {
            deviceToken: token,
            firstIp: cleanIp,
            lastIp: cleanIp,
            userAgent: cleanUserAgent,
            isIncognito: typeof isIncognito === "boolean" ? isIncognito : null,
            incognitoBrowser: incognitoBrowser?.trim() || null,
            lastSeenAt: new Date(),
          }),
        );
      } else {
        device.lastIp = cleanIp || device.lastIp;
        if (!device.firstIp && cleanIp) {
          device.firstIp = cleanIp;
        }
        device.userAgent = cleanUserAgent || device.userAgent;
        if (device.isIncognito === null && typeof isIncognito === "boolean") {
          device.isIncognito = isIncognito;
          device.incognitoBrowser = incognitoBrowser?.trim() || null;
        }
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
            name: "Ma Đạo Tử #" + (await this.generateUniqueGuestName(manager)),
            role: FilmUserRole.GUEST,
            status: FilmUserStatus.ACTIVE,
            currentTitle: DEFAULT_USER_TITLE,
          }),
        );
        await this.assignDefaultTitle(manager, user.id);
      }

      user.lastActiveAt = new Date();
      await manager.save(user);

      return { device, user };
    });
    if (ref && result.user?.id) {
      this.missionService
        .recordReferral(
          ref,
          result.user.id,
          ip || undefined,
          result.device.deviceToken,
          result.device.isIncognito,
        )
        .catch(() => { });
    }
    if (result.user?.id) {
      this.missionService.recordCheckin(result.user.id).catch(() => { });
    }
    return { device: result.device, ...(await this.issue(result.user)) };
  }

  async device(userId: string) {
    const user = await this.db.getRepository(FilmUser).findOneByOrFail({ id: userId });
    if (!user.deviceId) throw new UnauthorizedException("User has no device");
    return this.db.getRepository(FilmDevice).findOneByOrFail({ id: user.deviceId });
  }

  async adminLogin(identifier: string, password: string) {
    const trimmedId = identifier.trim().toLowerCase();

    // 1. Authenticate against platform_admin_users in Platform DB (kitools)
    try {
      const adminUserRepo = this.platformDb.getRepository(PlatformAdminUser);
      const adminUser = await adminUserRepo
        .createQueryBuilder("u")
        .leftJoinAndSelect("u.role", "role")
        .withDeleted()
        .where("lower(u.userName) = :id OR lower(u.email) = :id", { id: trimmedId })
        .getOne();

      if (adminUser) {
        if (!adminUser.passwordHash || !(await bcrypt.compare(password, adminUser.passwordHash))) {
          throw new UnauthorizedException("Mật khẩu không chính xác");
        }

        if (adminUser.deletedAt) {
          await adminUserRepo.restore(adminUser.id);
          adminUser.deletedAt = null;
          adminUser.isActive = true;
        } else if (!adminUser.isActive) {
          throw new UnauthorizedException("Tài khoản quản trị đã bị vô hiệu hóa");
        }

        adminUser.lastLoginAt = new Date();
        await adminUserRepo.save(adminUser);

        // Mirror user in Film DB for CMS operations (optional / safe fallback)
        try {
          const filmRepo = this.db.getRepository(FilmUser);
          let filmUser = await filmRepo.findOne({
            where: [{ id: adminUser.id }, { email: adminUser.email }],
            withDeleted: true,
          });

          if (filmUser?.deletedAt) {
            await filmRepo.restore(filmUser.id);
            filmUser.deletedAt = null;
          }

          if (!filmUser) {
            filmUser = filmRepo.create({
              id: adminUser.id,
              email: adminUser.email,
              username: adminUser.userName,
              name: adminUser.fullName || adminUser.userName || "Admin",
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
        } catch (mirrorErr) {
          this.logger.warn(`Skipping FilmUser mirror for admin: ${mirrorErr}`);
        }

        const issued = await this.issuePlatformAdmin(adminUser);
        return {
          ...issued,
          user: {
            id: adminUser.id,
            username: adminUser.userName,
            email: adminUser.email,
            fullName: adminUser.fullName,
            avatarUrl: adminUser.avatarUrl,
            phone: adminUser.phone,
            isSuperAdmin: adminUser.isSuperAdmin,
            role: adminUser.role?.code || "ADMIN",
            permissions: adminUser.role?.permissions || {},
            roleInfo: adminUser.role,
          },
        };
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(`Error querying platform admin users: ${err}`);
    }

    // 2. Fallback: Authenticate against Platform DB (kitlabs_platform)
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

        // Sync / update mirror user in Film DB for CMS operations (optional / safe)
        try {
          const filmRepo = this.db.getRepository(FilmUser);
          let filmUser = await filmRepo.findOne({
            where: [{ id: platformUser.id }, { email: platformUser.email ?? undefined }],
            withDeleted: true,
          });

          if (filmUser?.deletedAt) {
            await filmRepo.restore(filmUser.id);
            filmUser.deletedAt = null;
          }

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
        } catch (mirrorErr) {
          this.logger.warn(`Skipping FilmUser mirror for platform user: ${mirrorErr}`);
        }

        return this.issue(platformUser as any);
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      this.logger.error(`Error querying platform db for admin login: ${err}`);
    }

    // Admin authentication is intentionally restricted to Platform DB accounts.
    throw new UnauthorizedException("Thông tin đăng nhập không hợp lệ");
  }

  async refresh(refreshToken: string) {
    let payload: { sub: string; tokenType: string; authSource?: "film" | "platform-admin" };
    try {
      payload = await this.jwt.verifyAsync(refreshToken, {
        secret: process.env.FILM_JWT_REFRESH_SECRET || "film_refresh_secret_change_me",
      });
    } catch {
      throw new UnauthorizedException("Invalid refresh token");
    }
    if (payload.tokenType !== "refresh") throw new UnauthorizedException("Invalid refresh token");

    if (payload.authSource === "platform-admin") {
      const admin = await this.platformDb
        .getRepository(PlatformAdminUser)
        .createQueryBuilder("u")
        .addSelect("u.refreshTokenHash")
        .leftJoinAndSelect("u.role", "role")
        .where("u.id = :id", { id: payload.sub })
        .getOne();
      if (
        !admin?.isActive ||
        !admin.refreshTokenHash ||
        !(await bcrypt.compare(refreshToken, admin.refreshTokenHash))
      ) {
        throw new UnauthorizedException("Invalid refresh token");
      }
      return this.issuePlatformAdmin(admin);
    }

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

  async logout(userId: string, authSource?: "film" | "platform-admin") {
    if (authSource === "platform-admin") {
      await this.platformDb.getRepository(PlatformAdminUser).update(userId, { refreshTokenHash: null });
    } else {
      await this.db.getRepository(FilmUser).update(userId, { refreshTokenHash: null });
    }
    return { loggedOut: true };
  }

  async profile(userId: string, principal?: FilmPrincipal): Promise<any> {
    const isAdmin =
      principal?.authSource === "platform-admin" ||
      principal?.role === FilmUserRole.ADMIN;

    // 1. Lấy profile admin từ Platform DB (kitlabs_platform)
    try {
      const adminRepo = this.platformDb.getRepository(PlatformAdminUser);
      let adminUser = await adminRepo.findOne({
        where: { id: userId },
        relations: ["role"],
        withDeleted: true,
      });

      if (adminUser) {
        if (adminUser.deletedAt) {
          await adminRepo.restore(adminUser.id);
          adminUser.deletedAt = null;
          adminUser.isActive = true;
          await adminRepo.save(adminUser);
        }

        return {
          id: adminUser.id,
          username: adminUser.userName,
          email: adminUser.email,
          fullName: adminUser.fullName,
          avatarUrl: adminUser.avatarUrl,
          phone: adminUser.phone,
          isSuperAdmin: adminUser.isSuperAdmin,
          role: adminUser.role?.code || "ADMIN",
          permissions: adminUser.role?.permissions || {},
          roleInfo: adminUser.role,
        };
      }

      // 2. Fallback: Kiểm tra bảng users trong Platform DB
      const platformUserRepo = this.platformDb.getRepository(PlatformUser);
      const platformUser = await platformUserRepo.findOne({ where: { id: userId } });
      if (
        platformUser &&
        (platformUser.role === PlatformUserRole.ADMIN || platformUser.role === "ADMIN" || isAdmin)
      ) {
        return {
          id: platformUser.id,
          username: platformUser.userName,
          email: platformUser.email,
          fullName: platformUser.userName || "Admin",
          avatarUrl: null,
          phone: null,
          isSuperAdmin: true,
          role: "ADMIN",
          permissions: { "*": ["*"] },
          roleInfo: null,
        };
      }
    } catch (err) {
      if (isAdmin) {
        this.logger.error(`Error querying platform admin for profile: ${err}`);
        throw new NotFoundException("Tài khoản quản trị không tồn tại trong Platform DB");
      }
    }

    // Bắt buộc: Nếu là tài khoản quản trị (từ token), TUYỆT ĐỐI không fallback sang DB film
    if (isAdmin) {
      throw new NotFoundException("Tài khoản quản trị không tồn tại trong Platform DB");
    }

    // Table `users` trong DB film chỉ dùng cho người xem phim
    this.missionService.recordCheckin(userId).catch(() => { });

    const filmUserRepo = this.db.getRepository(FilmUser);
    let user: FilmUser;
    if (typeof filmUserRepo.findOne === "function") {
      const found = await filmUserRepo.findOne({
        where: { id: userId },
        withDeleted: true,
      });
      if (!found) {
        user = await filmUserRepo.findOneByOrFail({ id: userId });
      } else {
        user = found;
      }
    } else {
      user = await filmUserRepo.findOneByOrFail({ id: userId });
    }
    if (user.deletedAt) {
      if (typeof filmUserRepo.restore === "function") {
        await filmUserRepo.restore(user.id);
      }
      user.deletedAt = null;
      user.status = FilmUserStatus.ACTIVE;
      await filmUserRepo.save(user);
    }
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

    const rawTitle = equippedTitle?.currentTitle ?? user.currentTitle ?? null;
    const ranks = await resolveCultivationRanks(this.db);
    const cultivation = buildCultivationProgress(user.exp, rawTitle, ranks);

    return {
      ...user,
      currentTitle: cultivation.currentTitle,
      nextTitle: cultivation.nextTitle,
      nextTitleLabel: cultivation.nextTitleLabel,
      minExp: cultivation.minExp,
      nextExp: cultivation.nextExp,
      expPercentage: cultivation.expPercentage,
    };
  }

  async updateProfile(userId: string, dto: { name?: string; avatarUrl?: string }, principal?: FilmPrincipal) {
    const isAdmin =
      principal?.authSource === "platform-admin" ||
      principal?.role === FilmUserRole.ADMIN;

    if (isAdmin) {
      const adminRepo = this.platformDb.getRepository(PlatformAdminUser);
      let admin = await adminRepo.findOne({ where: { id: userId }, withDeleted: true });
      if (admin) {
        if (admin.deletedAt) {
          await adminRepo.restore(admin.id);
          admin.deletedAt = null;
          admin.isActive = true;
        }
        if (dto.name !== undefined) admin.fullName = dto.name.trim();
        if (dto.avatarUrl !== undefined) admin.avatarUrl = dto.avatarUrl?.trim() || null;
        await adminRepo.save(admin);
        return this.profile(userId, principal);
      }
      throw new NotFoundException("Tài khoản quản trị không tồn tại trong Platform DB");
    }

    const filmRepo = this.db.getRepository(FilmUser);
    const user = await filmRepo.findOneByOrFail({ id: userId });
    if (dto.name !== undefined) {
      const trimmed = dto.name.trim();
      if (trimmed.length < 2 || trimmed.length > 50) {
        throw new BadRequestException("Tên phải từ 2 đến 50 ký tự");
      }
      if (RESERVED_FILM_NAMES.has(normalizeProtectedName(trimmed))) {
        throw new BadRequestException("Tên này được dành riêng cho hệ thống và không thể sử dụng");
      }
      const duplicate = await filmRepo
        .createQueryBuilder("existingUser")
        .where("existingUser.id <> :userId", { userId })
        .andWhere("LOWER(TRIM(existingUser.name)) = LOWER(:name)", { name: trimmed })
        .getExists();
      if (duplicate) {
        throw new ConflictException("Tên này đã tồn tại, vui lòng chọn tên khác");
      }
      user.name = trimmed;
    }
    if (dto.avatarUrl !== undefined) {
      user.avatarUrl = dto.avatarUrl?.trim() || null;
    }
    await filmRepo.save(user);
    return this.profile(userId);
  }

  private async generateUniqueGuestName(manager: EntityManager): Promise<string> {
    const userRepository = manager.getRepository(FilmUser);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = randomInt(100_000, 1_000_000).toString();

      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `film:guest-name:${candidate}`,
      ]);

      const alreadyExists = await userRepository.exists({ where: { name: candidate } });
      if (!alreadyExists) return candidate;
    }

    throw new Error("Không thể tạo mã người dùng 6 chữ số không trùng");
  }

  private async assignDefaultTitle(manager: EntityManager, userId: string): Promise<void> {
    const titleItem = await manager
      .getRepository(FilmItem)
      .createQueryBuilder("item")
      .where("item.type = :type", { type: ItemType.TITLE })
      .andWhere("item.assetConfig ->> 'slug' IN (:...slugs)", {
        slugs: [DEFAULT_USER_TITLE, "luyen_khi_so_ky"],
      })
      .getOne();

    if (!titleItem) {
      throw new Error(`Default TITLE item ${DEFAULT_USER_TITLE} is not configured`);
    }

    await manager.getRepository(FilmUserInventory).save(
      manager.getRepository(FilmUserInventory).create({
        userId,
        itemId: titleItem.id,
        isEquipped: true,
        expiresAt: null,
      }),
    );
  }

  private async issue(user: FilmUser) {
    const base = { sub: user.id, deviceId: user.deviceId, role: user.role, authSource: "film" as const };
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
    const ranks = await resolveCultivationRanks(this.db);
    const cultivation = buildCultivationProgress(user.exp, user.currentTitle, ranks);
    return {
      user: {
        ...user,
        currentTitle: cultivation.currentTitle,
        nextTitle: cultivation.nextTitle,
        nextTitleLabel: cultivation.nextTitleLabel,
        minExp: cultivation.minExp,
        nextExp: cultivation.nextExp,
        expPercentage: cultivation.expPercentage,
      },
      accessToken,
      refreshToken,
      accessTokenExpiresIn: process.env.FILM_JWT_ACCESS_EXPIRES_IN || "15m",
    };
  }

  private async issuePlatformAdmin(admin: PlatformAdminUser) {
    const base = {
      sub: admin.id,
      deviceId: null,
      role: FilmUserRole.ADMIN,
      authSource: "platform-admin" as const,
    };
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
    await this.platformDb.getRepository(PlatformAdminUser).update(admin.id, {
      refreshTokenHash: await bcrypt.hash(refreshToken, 10),
    });
    return {
      user: {
        id: admin.id,
        username: admin.userName,
        email: admin.email,
        fullName: admin.fullName,
        avatarUrl: admin.avatarUrl,
        phone: admin.phone,
        isSuperAdmin: admin.isSuperAdmin,
        role: admin.role?.code || "ADMIN",
        permissions: admin.role?.permissions || {},
        roleInfo: admin.role,
      },
      accessToken,
      refreshToken,
      accessTokenExpiresIn: process.env.FILM_JWT_ACCESS_EXPIRES_IN || "15m",
    };
  }
}
