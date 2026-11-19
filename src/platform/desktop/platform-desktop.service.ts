import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource, IsNull, Not } from "typeorm";
import { PlatformDesktopDevice } from "../entities/desktop-device.entity";
import { DESKTOP_MENU_CATALOG, normalizeAllowedMenus } from "./desktop-menu.catalog";

export type DesktopDeviceAccessResponse = {
  deviceId: string;
  registered: boolean;
  isActive: boolean;
  label: string | null;
  allowedMenus: string[] | null;
};

@Injectable()
export class PlatformDesktopService {
  constructor(@InjectDataSource() private readonly db: DataSource) {}

  getCatalog() {
    return DESKTOP_MENU_CATALOG;
  }

  async getAccessByDeviceId(
    rawDeviceId?: string,
    opts?: { appVersion?: string; ip?: string },
  ): Promise<DesktopDeviceAccessResponse> {
    const deviceId = String(rawDeviceId || "").trim().toLowerCase();
    if (!deviceId) {
      throw new BadRequestException("deviceId is required");
    }

    const repo = this.db.getRepository(PlatformDesktopDevice);
    const device = await repo.findOne({
      where: { deviceId, deletedAt: IsNull() },
    });

    if (!device) {
      return {
        deviceId,
        registered: false,
        isActive: true,
        label: null,
        allowedMenus: null,
      };
    }

    await repo
      .update(device.id, {
        lastSeenAt: new Date(),
        ...(opts?.ip ? { lastIp: opts.ip.slice(0, 64) } : {}),
        ...(opts?.appVersion ? { appVersion: opts.appVersion.slice(0, 64) } : {}),
      })
      .catch(() => {});

    return {
      deviceId,
      registered: true,
      isActive: device.isActive,
      label: device.label || null,
      allowedMenus: device.isActive ? normalizeAllowedMenus(device.allowedMenus) : [],
    };
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
      qb.andWhere("(LOWER(d.device_id) LIKE :q OR LOWER(d.label) LIKE :q)", { q });
    }

    if (filter?.isActive === "true") {
      qb.andWhere("d.is_active = true");
    } else if (filter?.isActive === "false") {
      qb.andWhere("d.is_active = false");
    }

    qb.orderBy("d.createdAt", "DESC").skip(skip).take(take);
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
      throw new ConflictException(
        existing.deletedAt
          ? "Device ID này đã tồn tại trong thùng rác, hãy khôi phục thay vì tạo mới."
          : "Device ID này đã tồn tại.",
      );
    }

    const entity = repo.create({
      deviceId,
      label: String(data.label || "").trim(),
      note: data.note ? String(data.note).trim() : null,
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
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
