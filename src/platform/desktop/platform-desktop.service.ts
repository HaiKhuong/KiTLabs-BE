import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, IsNull, Not } from "typeorm";
import { PlatformDesktopDevice } from "../entities/desktop-device.entity";
import { PlatformUser } from "../entities/platform-user.entity";
import { DESKTOP_MENU_CATALOG, normalizeAllowedMenus } from "./desktop-menu.catalog";

export type DesktopDeviceAccessResponse = {
  deviceId: string;
  registered: boolean;
  isActive: boolean;
  label: string | null;
  allowedMenus: string[] | null;
};

export type DiscoveredDesktopDeviceItem = {
  deviceId: string;
  hostname: string | null;
  label: string | null;
  appVersion: string | null;
  lastIp: string | null;
  lastSeenAt: string | null;
  source: "desktop" | "user";
};

@Injectable()
export class PlatformDesktopService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  getCatalog() {
    return DESKTOP_MENU_CATALOG;
  }

  async getAccessByDeviceId(
    rawDeviceId?: string,
    opts?: { appVersion?: string; ip?: string; hostname?: string },
  ): Promise<DesktopDeviceAccessResponse> {
    const deviceId = String(rawDeviceId || "").trim().toLowerCase();
    if (!deviceId) {
      throw new BadRequestException("deviceId is required");
    }

    const hostname = opts?.hostname?.trim().slice(0, 150) || null;
    const ip = opts?.ip?.trim().slice(0, 64) || null;
    const appVersion = opts?.appVersion?.trim().slice(0, 64) || null;

    const repo = this.db.getRepository(PlatformDesktopDevice);
    const device = await repo.findOne({
      where: { deviceId },
      withDeleted: true,
    });

    if (!device) {
      const created = repo.create({
        deviceId,
        label: hostname || "",
        hostname,
        isActive: true,
        isConfigured: false,
        allowedMenus: [],
        appVersion,
        lastIp: ip,
        lastSeenAt: new Date(),
      });
      await repo.save(created).catch(() => {});
      return {
        deviceId,
        registered: false,
        isActive: true,
        label: hostname,
        allowedMenus: null,
      };
    }

    await repo
      .update(device.id, {
        lastSeenAt: new Date(),
        ...(ip ? { lastIp: ip } : {}),
        ...(appVersion ? { appVersion } : {}),
        ...(hostname ? { hostname, ...(!device.label ? { label: hostname } : {}) } : {}),
      })
      .catch(() => {});

    if (device.deletedAt || !device.isActive) {
      return {
        deviceId,
        registered: Boolean(device.isConfigured),
        isActive: device.isActive,
        label: device.label || hostname || null,
        allowedMenus: device.deletedAt ? null : [],
      };
    }

    const normalized = normalizeAllowedMenus(device.allowedMenus);
    const hasRestrictedMenus = device.isConfigured && normalized.length > 0;

    return {
      deviceId,
      registered: device.isConfigured,
      isActive: true,
      label: device.label || hostname || null,
      allowedMenus: hasRestrictedMenus ? normalized : null,
    };
  }

  async listDiscoveredDevices(): Promise<DiscoveredDesktopDeviceItem[]> {
    const deviceRepo = this.db.getRepository(PlatformDesktopDevice);
    const userRepo = this.db.getRepository(PlatformUser);

    const allDevices = await deviceRepo
      .createQueryBuilder("d")
      .where("d.deleted_at IS NULL")
      .orderBy("d.lastSeenAt", "DESC", "NULLS LAST")
      .addOrderBy("d.updatedAt", "DESC")
      .take(200)
      .getMany();

    const configuredIds = new Set(
      allDevices.filter((d) => d.isConfigured).map((d) => d.deviceId.toLowerCase()),
    );

    const resultMap = new Map<string, DiscoveredDesktopDeviceItem>();
    for (const d of allDevices) {
      if (d.isConfigured) continue;
      const key = d.deviceId.toLowerCase();
      resultMap.set(key, {
        deviceId: d.deviceId,
        hostname: d.hostname || null,
        label: d.label || d.hostname || null,
        appVersion: d.appVersion || null,
        lastIp: d.lastIp || null,
        lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : d.updatedAt?.toISOString() || null,
        source: "desktop",
      });
    }

    const users = await userRepo
      .createQueryBuilder("u")
      .where("u.device_id IS NOT NULL AND TRIM(u.device_id) <> ''")
      .orderBy("u.updatedAt", "DESC")
      .take(200)
      .getMany();

    for (const u of users) {
      const key = String(u.deviceId || "").trim().toLowerCase();
      if (!key || configuredIds.has(key) || resultMap.has(key)) continue;
      resultMap.set(key, {
        deviceId: key,
        hostname: u.userName || null,
        label: u.userName || null,
        appVersion: null,
        lastIp: u.ip || null,
        lastSeenAt: u.updatedAt ? u.updatedAt.toISOString() : null,
        source: "user",
      });
    }

    return Array.from(resultMap.values());
  }

  async listDevices(
    page = 1,
    limit = 20,
    filter?: { deleted?: string; search?: string; isActive?: string },
  ) {
    const repo = this.db.getRepository(PlatformDesktopDevice);
    const take = Math.min(100, Math.max(1, limit));
    const skip = (Math.max(1, page) - 1) * take;
    const isDeleted = filter?.deleted === "true";

    const qb = repo
      .createQueryBuilder("d")
      .withDeleted()
      .where(isDeleted ? "d.deleted_at IS NOT NULL" : "d.deleted_at IS NULL");

    if (filter?.search?.trim()) {
      const q = `%${filter.search.trim().toLowerCase()}%`;
      qb.andWhere(
        "(LOWER(d.device_id) LIKE :q OR LOWER(d.label) LIKE :q OR LOWER(COALESCE(d.hostname, '')) LIKE :q)",
        { q },
      );
    }

    if (filter?.isActive === "true") {
      qb.andWhere("d.is_active = true");
    } else if (filter?.isActive === "false") {
      qb.andWhere("d.is_active = false");
    }

    qb.orderBy("d.lastSeenAt", "DESC", "NULLS LAST")
      .addOrderBy("d.createdAt", "DESC")
      .skip(skip)
      .take(take);
    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, limit: take };
  }

  async getDevice(id: string) {
    const repo = this.db.getRepository(PlatformDesktopDevice);
    const item = await repo.findOne({ where: { id }, withDeleted: true });
    if (!item) throw new NotFoundException("Device not found");
    return item;
  }

  async createDevice(data: Record<string, any>) {
    const deviceId = String(data.deviceId || "").trim().toLowerCase();
    if (!deviceId) {
      throw new BadRequestException("deviceId is required");
    }

    const repo = this.db.getRepository(PlatformDesktopDevice);
    const existing = await repo.findOne({
      where: { deviceId },
      withDeleted: true,
    });
    if (existing) {
      if (existing.isConfigured) {
        throw new ConflictException(
          existing.deletedAt
            ? "Device ID này đã tồn tại trong thùng rác, hãy khôi phục thay vì tạo mới."
            : "Device ID này đã tồn tại.",
        );
      }
      // Upgrade auto-discovered device into configured Admin rule
      existing.deletedAt = null;
      existing.isConfigured = true;
      existing.label = String(data.label ?? existing.label ?? "").trim();
      existing.note = data.note ? String(data.note).trim() : null;
      existing.isActive = data.isActive !== undefined ? Boolean(data.isActive) : true;
      existing.allowedMenus = normalizeAllowedMenus(data.allowedMenus);
      return repo.save(existing);
    }

    const entity = repo.create({
      deviceId,
      label: String(data.label || "").trim(),
      note: data.note ? String(data.note).trim() : null,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      isConfigured: true,
      allowedMenus: normalizeAllowedMenus(data.allowedMenus),
    });

    return repo.save(entity);
  }

  async updateDevice(id: string, data: Record<string, any>) {
    const repo = this.db.getRepository(PlatformDesktopDevice);
    const entity = await repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException("Device not found");

    if (data.deviceId !== undefined) {
      const nextDeviceId = String(data.deviceId || "").trim().toLowerCase();
      if (!nextDeviceId) {
        throw new BadRequestException("deviceId cannot be empty");
      }
      if (nextDeviceId !== entity.deviceId) {
        const dup = await repo.findOne({
          where: { deviceId: nextDeviceId, id: Not(id) },
          withDeleted: true,
        });
        if (dup) throw new ConflictException("Device ID đã tồn tại");
        entity.deviceId = nextDeviceId;
      }
    }

    if (data.label !== undefined) entity.label = String(data.label || "").trim();
    if (data.note !== undefined) entity.note = data.note ? String(data.note).trim() : null;
    if (data.isActive !== undefined) entity.isActive = Boolean(data.isActive);
    if (data.allowedMenus !== undefined) {
      entity.allowedMenus = normalizeAllowedMenus(data.allowedMenus);
    }
    entity.isConfigured = true;

    return repo.save(entity);
  }

  async deleteDevice(id: string) {
    const repo = this.db.getRepository(PlatformDesktopDevice);
    const entity = await repo.findOne({ where: { id } });
    if (!entity) throw new NotFoundException("Device not found");
    await repo.softDelete(id);
    return { deleted: true, id };
  }

  async restoreDevice(id: string) {
    const repo = this.db.getRepository(PlatformDesktopDevice);
    const entity = await repo.findOne({ where: { id }, withDeleted: true });
    if (!entity) throw new NotFoundException("Device not found");
    await repo.restore(id);
    return repo.findOne({ where: { id } });
  }
}
