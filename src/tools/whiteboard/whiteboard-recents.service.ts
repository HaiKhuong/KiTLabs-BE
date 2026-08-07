import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { copyFileSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { Repository } from "typeorm";

import { WhiteboardRecentImage } from "./whiteboard-recent-image.entity";

const RECENT_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
]);

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_STORED = 50;

export type WhiteboardRecentImageDto = {
  id: string;
  userId: string;
  fileName: string;
  originalName: string;
  mimeType: string | null;
  fileSize: number;
  previewUrl: string;
  lastUsedAt: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class WhiteboardRecentsService {
  constructor(
    @InjectRepository(WhiteboardRecentImage, "tool")
    private readonly repository: Repository<WhiteboardRecentImage>,
  ) {}

  resolveWorkRoot(): string {
    return resolve(process.cwd(), process.env.WHITEBOARD_WORK_ROOT ?? "uploads/whiteboard");
  }

  resolveRecentsRoot(): string {
    return join(this.resolveWorkRoot(), "_recents");
  }

  resolveUserRecentsDir(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "anon";
    return join(this.resolveRecentsRoot(), safe);
  }

  resolveRecentFilePath(userId: string, fileName: string): string {
    const safeName = basenameSafe(fileName);
    return join(this.resolveUserRecentsDir(userId), safeName);
  }

  toDto(row: WhiteboardRecentImage): WhiteboardRecentImageDto {
    return {
      id: row.id,
      userId: row.userId,
      fileName: row.fileName,
      originalName: row.originalName,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      previewUrl: `/api/tools/whiteboard/recents/${encodeURIComponent(row.id)}?userId=${encodeURIComponent(row.userId)}`,
      lastUsedAt: row.lastUsedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(userId: string, limit = DEFAULT_RECENT_LIMIT): Promise<WhiteboardRecentImageDto[]> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const take = Math.min(100, Math.max(1, Math.round(Number(limit) || DEFAULT_RECENT_LIMIT)));
    const rows = await this.repository.find({
      where: { userId: uid },
      order: { lastUsedAt: "DESC" },
      take,
    });
    return rows.map((row) => this.toDto(row));
  }

  async upload(userId: string, file: Express.Multer.File): Promise<WhiteboardRecentImageDto> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    if (!file?.buffer?.length) throw new BadRequestException("file is required");
    if (!RECENT_IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported recent image type: ${file.mimetype}`);
    }

    let ext = extname(file.originalname).toLowerCase();
    if (!ext) {
      if (file.mimetype === "image/svg+xml") ext = ".svg";
      else if (file.mimetype === "image/webp") ext = ".webp";
      else if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") ext = ".jpg";
      else ext = ".png";
    }

    const now = new Date();
    const row = this.repository.create({
      userId: uid,
      fileName: "",
      originalName: (file.originalname || `recent${ext}`).slice(0, 512),
      mimeType: file.mimetype,
      fileSize: file.buffer.length,
      lastUsedAt: now,
    });
    const saved = await this.repository.save(row);
    const fileName = `${saved.id}${ext}`;
    saved.fileName = fileName;

    const dir = this.resolveUserRecentsDir(uid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), file.buffer);
    const updated = await this.repository.save(saved);
    await this.trimOverflow(uid);
    return this.toDto(updated);
  }

  async touch(id: string, userId: string): Promise<WhiteboardRecentImageDto> {
    const row = await this.getOwned(id, userId);
    row.lastUsedAt = new Date();
    const updated = await this.repository.save(row);
    return this.toDto(updated);
  }

  async getOwned(id: string, userId: string): Promise<WhiteboardRecentImage> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const row = await this.repository.findOne({ where: { id, userId: uid } });
    if (!row) throw new NotFoundException("Recent image not found");
    return row;
  }

  async resolveOwnedPath(id: string, userId: string): Promise<string> {
    const row = await this.getOwned(id, userId);
    const full = this.resolveRecentFilePath(row.userId, row.fileName);
    if (!existsSync(full)) throw new NotFoundException("Recent image file missing");
    return full;
  }

  async delete(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.getOwned(id, userId);
    this.safeUnlink(this.resolveRecentFilePath(row.userId, row.fileName));
    await this.repository.delete({ id: row.id });
    return { deleted: true, id: row.id };
  }

  async clearAll(userId: string): Promise<{ deleted: number }> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const rows = await this.repository.find({ where: { userId: uid } });
    for (const row of rows) {
      this.safeUnlink(this.resolveRecentFilePath(row.userId, row.fileName));
    }
    if (rows.length > 0) {
      await this.repository.delete({ userId: uid });
    }
    return { deleted: rows.length };
  }

  /** Copy owned recent files into a target directory; returns metadata for history. */
  async copyOwnedToDir(
    userId: string,
    recentIds: string[],
    targetDir: string,
  ): Promise<Array<{ id: string; originalName: string; fileName: string }>> {
    mkdirSync(targetDir, { recursive: true });
    const out: Array<{ id: string; originalName: string; fileName: string }> = [];
    const seen = new Set<string>();
    for (const rawId of recentIds) {
      const id = String(rawId ?? "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      try {
        const row = await this.getOwned(id, userId);
        const src = this.resolveRecentFilePath(row.userId, row.fileName);
        if (!existsSync(src)) continue;
        const destName = `${out.length + 1}_${row.fileName}`;
        copyFileSync(src, join(targetDir, destName));
        out.push({ id: row.id, originalName: row.originalName, fileName: destName });
        row.lastUsedAt = new Date();
        await this.repository.save(row);
      } catch {
        // skip missing / unauthorized
      }
    }
    return out;
  }

  private async trimOverflow(userId: string): Promise<void> {
    const rows = await this.repository.find({
      where: { userId },
      order: { lastUsedAt: "DESC" },
    });
    if (rows.length <= MAX_RECENT_STORED) return;
    const overflow = rows.slice(MAX_RECENT_STORED);
    for (const row of overflow) {
      this.safeUnlink(this.resolveRecentFilePath(row.userId, row.fileName));
      await this.repository.delete({ id: row.id });
    }
  }

  private safeUnlink(full: string): void {
    if (!existsSync(full)) return;
    try {
      unlinkSync(full);
    } catch {
      // ignore disk errors
    }
  }
}

function basenameSafe(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new BadRequestException("Invalid recent file name");
  }
  return cleaned;
}
