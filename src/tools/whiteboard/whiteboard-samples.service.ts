import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { extname, join, resolve } from "path";
import { Repository } from "typeorm";

import { resolveConfiguredPath } from "../../common/desktop/data-path";
import { WhiteboardSampleImage } from "./whiteboard-sample-image.entity";

const SAMPLE_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
]);

export type WhiteboardSampleImageDto = {
  id: string;
  userId: string;
  fileName: string;
  originalName: string;
  mimeType: string | null;
  fileSize: number;
  previewUrl: string;
  createdAt: string;
  updatedAt: string;
};

@Injectable()
export class WhiteboardSamplesService {
  constructor(
    @InjectRepository(WhiteboardSampleImage, "tool")
    private readonly repository: Repository<WhiteboardSampleImage>,
  ) {}

  resolveWorkRoot(): string {
    return resolveConfiguredPath(process.env.WHITEBOARD_WORK_ROOT, "uploads/whiteboard");
  }

  resolveSamplesRoot(): string {
    return join(this.resolveWorkRoot(), "_samples");
  }

  resolveUserSamplesDir(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "anon";
    return join(this.resolveSamplesRoot(), safe);
  }

  resolveSampleFilePath(userId: string, fileName: string): string {
    const safeName = basenameSafe(fileName);
    return join(this.resolveUserSamplesDir(userId), safeName);
  }

  toDto(row: WhiteboardSampleImage): WhiteboardSampleImageDto {
    return {
      id: row.id,
      userId: row.userId,
      fileName: row.fileName,
      originalName: row.originalName,
      mimeType: row.mimeType,
      fileSize: row.fileSize,
      previewUrl: `/api/tools/whiteboard/samples/${encodeURIComponent(row.id)}?userId=${encodeURIComponent(row.userId)}`,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(userId: string): Promise<WhiteboardSampleImageDto[]> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const rows = await this.repository.find({
      where: { userId: uid },
      order: { createdAt: "DESC" },
    });
    return rows.map((row) => this.toDto(row));
  }

  async upload(userId: string, file: Express.Multer.File): Promise<WhiteboardSampleImageDto> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    if (!file?.buffer?.length) throw new BadRequestException("file is required");
    if (!SAMPLE_IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported sample image type: ${file.mimetype}`);
    }

    let ext = extname(file.originalname).toLowerCase();
    if (!ext) {
      if (file.mimetype === "image/svg+xml") ext = ".svg";
      else if (file.mimetype === "image/webp") ext = ".webp";
      else if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") ext = ".jpg";
      else ext = ".png";
    }

    const row = this.repository.create({
      userId: uid,
      fileName: "",
      originalName: (file.originalname || `sample${ext}`).slice(0, 512),
      mimeType: file.mimetype,
      fileSize: file.buffer.length,
    });
    const saved = await this.repository.save(row);
    const fileName = `${saved.id}${ext}`;
    saved.fileName = fileName;

    const dir = this.resolveUserSamplesDir(uid);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), file.buffer);
    const updated = await this.repository.save(saved);
    return this.toDto(updated);
  }

  async getOwned(id: string, userId: string): Promise<WhiteboardSampleImage> {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const row = await this.repository.findOne({ where: { id, userId: uid } });
    if (!row) throw new NotFoundException("Sample image not found");
    return row;
  }

  async resolveOwnedPath(id: string, userId: string): Promise<string> {
    const row = await this.getOwned(id, userId);
    const full = this.resolveSampleFilePath(row.userId, row.fileName);
    if (!existsSync(full)) throw new NotFoundException("Sample image file missing");
    return full;
  }

  async delete(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    const row = await this.getOwned(id, userId);
    const full = this.resolveSampleFilePath(row.userId, row.fileName);
    if (existsSync(full)) {
      try {
        unlinkSync(full);
      } catch {
        // ignore disk errors; still remove DB row
      }
    }
    await this.repository.delete({ id: row.id });
    return { deleted: true, id: row.id };
  }
}

function basenameSafe(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!cleaned || cleaned === "." || cleaned === "..") {
    throw new BadRequestException("Invalid sample file name");
  }
  return cleaned;
}
