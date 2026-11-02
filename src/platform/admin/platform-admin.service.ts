import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import * as bcrypt from "bcrypt";
import { DataSource, IsNull, Not } from "typeorm";
import { PlatformAdminRole } from "../entities/platform-admin-role.entity";
import { PlatformAdminUser } from "../entities/platform-admin-user.entity";

@Injectable()
export class PlatformAdminService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  // ===================== ROLES =====================

  private sanitizePermissions(permissions: Record<string, any> = {}): Record<string, any> {
    const sanitized: Record<string, any> = { ...permissions };
    for (const key of Object.keys(sanitized)) {
      const p = sanitized[key];
      if (p && typeof p === "object") {
        if (p.create || p.update || p.delete) {
          p.read = true;
        }
      }
    }
    return sanitized;
  }

  async listRoles(page = 1, limit = 50, filter?: { deleted?: string; search?: string }) {
    const repo = this.db.getRepository(PlatformAdminRole);
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const qb = repo.createQueryBuilder("r");

    if (filter?.deleted === "true") {
      qb.withDeleted().where("r.deletedAt IS NOT NULL");
    } else if (filter?.deleted === "all") {
      qb.withDeleted();
    } else {
      qb.where("r.deletedAt IS NULL");
    }

    if (filter?.search) {
      qb.andWhere("(lower(r.name) LIKE :q OR lower(r.code) LIKE :q)", {
        q: `%${filter.search.trim().toLowerCase()}%`,
      });
    }

    qb.orderBy("r.createdAt", "DESC").take(take).skip(skip);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page: Math.max(1, page), limit: take };
  }

  async oneRole(id: string) {
    const role = await this.db.getRepository(PlatformAdminRole).findOne({
      where: { id },
      withDeleted: true,
      relations: ["users"],
    });
    if (!role) throw new NotFoundException("Vai trò không tồn tại");
    return role;
  }

  async createRole(data: Partial<PlatformAdminRole>) {
    const repo = this.db.getRepository(PlatformAdminRole);
    const code = (data.code || "").trim().toUpperCase();
    if (!code) throw new BadRequestException("Mã vai trò không được để trống");

    const exists = await repo.findOne({ where: { code }, withDeleted: true });
    if (exists) throw new BadRequestException("Mã vai trò đã tồn tại");

    const permissions = this.sanitizePermissions(data.permissions || {});
    const role = repo.create({
      code,
      name: data.name?.trim() || code,
      description: data.description || null,
      isSystem: Boolean(data.isSystem),
      permissions,
    });
    return repo.save(role);
  }

  async updateRole(id: string, data: Partial<PlatformAdminRole>) {
    const repo = this.db.getRepository(PlatformAdminRole);
    const role = await this.oneRole(id);

    if (data.name !== undefined) role.name = data.name.trim();
    if (data.description !== undefined) role.description = data.description;
    if (data.permissions !== undefined) {
      role.permissions = this.sanitizePermissions(data.permissions);
    }
    return repo.save(role);
  }

  async deleteRole(id: string) {
    const repo = this.db.getRepository(PlatformAdminRole);
    const role = await this.oneRole(id);
    if (role.isSystem) {
      throw new BadRequestException("Không thể xóa vai trò mặc định của hệ thống");
    }
    await repo.softDelete(id);
    return { deleted: true };
  }

  async restoreRole(id: string) {
    const repo = this.db.getRepository(PlatformAdminRole);
    await this.oneRole(id);
    await repo.restore(id);
    return { restored: true };
  }

  // ===================== ADMIN USERS =====================

  async listUsers(
    page = 1,
    limit = 20,
    filter?: { deleted?: string; search?: string; roleId?: string; isActive?: boolean },
  ) {
    const repo = this.db.getRepository(PlatformAdminUser);
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;

    const qb = repo.createQueryBuilder("u").leftJoinAndSelect("u.role", "role");

    if (filter?.deleted === "true") {
      qb.withDeleted().where("u.deletedAt IS NOT NULL");
    } else if (filter?.deleted === "all") {
      qb.withDeleted();
    } else {
      qb.where("u.deletedAt IS NULL");
    }

    if (filter?.search) {
      qb.andWhere(
        "(lower(u.userName) LIKE :q OR lower(u.email) LIKE :q OR lower(u.fullName) LIKE :q)",
        { q: `%${filter.search.trim().toLowerCase()}%` },
      );
    }

    if (filter?.roleId) {
      qb.andWhere("u.roleId = :roleId", { roleId: filter.roleId });
    }

    if (filter?.isActive !== undefined) {
      qb.andWhere("u.isActive = :isActive", { isActive: filter.isActive });
    }

    qb.orderBy("u.createdAt", "DESC").take(take).skip(skip);

    const [items, total] = await qb.getManyAndCount();

    // Mask password
    const safeItems = items.map((u) => {
      const copy: any = { ...u };
      delete copy.passwordHash;
      delete copy.refreshTokenHash;
      return copy;
    });

    return { items: safeItems, total, page: Math.max(1, page), limit: take };
  }

  async oneUser(id: string) {
    const user = await this.db.getRepository(PlatformAdminUser).findOne({
      where: { id },
      withDeleted: true,
      relations: ["role"],
    });
    if (!user) throw new NotFoundException("Tài khoản quản trị không tồn tại");

    const copy: any = { ...user };
    delete copy.passwordHash;
    delete copy.refreshTokenHash;
    return copy;
  }

  async createUser(data: Record<string, any>) {
    const repo = this.db.getRepository(PlatformAdminUser);
    const userName = (data.userName || data.username || "").trim().toLowerCase();
    const email = (data.email || "").trim().toLowerCase();
    const password = data.password || data.passwordHash || "";

    if (!userName) throw new BadRequestException("Tên đăng nhập không được để trống");
    if (!email) throw new BadRequestException("Email không được để trống");
    if (!password || password.length < 6) {
      throw new BadRequestException("Mật khẩu phải có ít nhất 6 ký tự");
    }

    const existing = await repo.findOne({
      where: [{ userName }, { email }],
      withDeleted: true,
    });
    if (existing) {
      throw new BadRequestException("Tên đăng nhập hoặc email đã được sử dụng");
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = repo.create({
      userName,
      email,
      passwordHash,
      fullName: data.fullName || data.name || null,
      phone: data.phone || null,
      avatarUrl: data.avatarUrl || null,
      roleId: data.roleId || null,
      isSuperAdmin: Boolean(data.isSuperAdmin),
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
    });

    const saved = await repo.save(user);
    return this.oneUser(saved.id);
  }

  async updateUser(id: string, data: Record<string, any>) {
    const repo = this.db.getRepository(PlatformAdminUser);
    const user = await repo.findOne({ where: { id }, withDeleted: true });
    if (!user) throw new NotFoundException("Tài khoản quản trị không tồn tại");

    if (data.email && data.email.trim().toLowerCase() !== user.email) {
      const checkEmail = await repo.findOne({
        where: { email: data.email.trim().toLowerCase() },
        withDeleted: true,
      });
      if (checkEmail && checkEmail.id !== id) {
        throw new BadRequestException("Email đã được sử dụng bởi tài khoản khác");
      }
      user.email = data.email.trim().toLowerCase();
    }

    if (data.password) {
      if (data.password.length < 6) {
        throw new BadRequestException("Mật khẩu mới phải có ít nhất 6 ký tự");
      }
      user.passwordHash = await bcrypt.hash(data.password, 10);
    }

    if (data.fullName !== undefined) user.fullName = data.fullName;
    if (data.phone !== undefined) user.phone = data.phone;
    if (data.avatarUrl !== undefined) user.avatarUrl = data.avatarUrl;
    if (data.roleId !== undefined) user.roleId = data.roleId || null;
    if (data.isSuperAdmin !== undefined) user.isSuperAdmin = Boolean(data.isSuperAdmin);
    if (data.isActive !== undefined) user.isActive = Boolean(data.isActive);

    await repo.save(user);
    return this.oneUser(id);
  }

  async deleteUser(id: string) {
    const repo = this.db.getRepository(PlatformAdminUser);
    const user = await repo.findOne({ where: { id }, withDeleted: true });
    if (!user) throw new NotFoundException("Tài khoản quản trị không tồn tại");

    if (user.isSuperAdmin) {
      const superAdmins = await repo.count({
        where: { isSuperAdmin: true, deletedAt: IsNull() },
      });
      if (superAdmins <= 1) {
        throw new BadRequestException("Không thể xóa Super Admin duy nhất của hệ thống");
      }
    }

    await repo.softDelete(id);
    return { deleted: true };
  }

  async restoreUser(id: string) {
    const repo = this.db.getRepository(PlatformAdminUser);
    const user = await repo.findOne({ where: { id }, withDeleted: true });
    if (!user) throw new NotFoundException("Tài khoản quản trị không tồn tại");
    await repo.restore(id);
    return { restored: true };
  }
}

