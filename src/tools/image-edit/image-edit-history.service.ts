import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { existsSync } from "fs";
import { basename, extname, isAbsolute, relative, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import type { ImageEditDomain, ImageEditFeature, ImageEditScale } from "./image-edit.constants";
import { imageEditJobDir } from "./image-edit.constants";
import {
  ImageEditHistory,
  type ImageEditDetection,
  type ImageEditFileMeta,
  type ImageEditOptions,
} from "./image-edit-history.entity";

export type ImageEditClientFile = {
  name: string;
  url: string;
  label?: string;
  confidence?: number;
};

export type ImageEditClientJob = {
  id: string;
  feature: ImageEditFeature;
  displayName: string;
  status: QueueJobStatus;
  inputUrl: string | null;
  resultUrl: string | null;
  files: ImageEditClientFile[];
  detections: ImageEditDetection[];
  scale: ImageEditScale | null;
  domain: ImageEditDomain | null;
  errorMessage: string | null;
  createdAt: string;
};

@Injectable()
export class ImageEditHistoryService {
  constructor(
    @InjectRepository(ImageEditHistory, "tool")
    private readonly historyRepo: Repository<ImageEditHistory>,
  ) {}

  async createPending(input: {
    userId: string;
    feature: ImageEditFeature;
    displayName: string;
    options: ImageEditOptions;
  }): Promise<ImageEditHistory> {
    const row = this.historyRepo.create({
      userId: input.userId,
      feature: input.feature,
      displayName: input.displayName.slice(0, 255),
      status: QueueJobStatus.PENDING,
      options: input.options,
      inputPath: null,
      inputFileName: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
      queueJobId: null,
    });
    return this.historyRepo.save(row);
  }

  async attachInput(id: string, inputPath: string, inputFileName: string): Promise<void> {
    await this.historyRepo.update(id, {
      inputPath: inputPath.replaceAll("\\", "/"),
      inputFileName,
    });
  }

  async attachQueueJob(id: string, queueJobId: string): Promise<void> {
    await this.historyRepo.update(id, { queueJobId });
  }

  async markRunning(id: string): Promise<void> {
    await this.historyRepo.update(id, { status: QueueJobStatus.RUNNING, errorMessage: null });
  }

  async markCompleted(
    id: string,
    resultPath: string,
    resultFileName: string | null,
    options: ImageEditOptions,
  ): Promise<void> {
    await this.historyRepo.update(id, {
      status: QueueJobStatus.COMPLETED,
      resultPath: resultPath.replaceAll("\\", "/"),
      resultFileName,
      options,
      errorMessage: null,
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.historyRepo.update(id, {
      status: QueueJobStatus.FAILED,
      errorMessage: errorMessage.slice(0, 4000),
    });
  }

  getById(id: string): Promise<ImageEditHistory | null> {
    return this.historyRepo.findOne({ where: { id } });
  }

  async list(userId: string, feature: ImageEditFeature, page: number, limit: number) {
    const safePage = Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 50) : 12;
    const [items, total] = await this.historyRepo.findAndCount({
      where: { userId, feature },
      order: { createdAt: "DESC" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      hasMore: safePage * safeLimit < total,
    };
  }

  jobDir(row: Pick<ImageEditHistory, "feature" | "userId" | "id">): string {
    return imageEditJobDir(row.feature, row.userId, row.id);
  }

  resolveFile(row: ImageEditHistory, filename: string): string {
    const safeName = basename(filename);
    if (!safeName || safeName !== filename || safeName.includes("..")) {
      throw new NotFoundException("File not found");
    }
    const jobDir = resolve(this.jobDir(row));
    const target = resolve(jobDir, safeName);
    const rel = relative(jobDir, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw new NotFoundException("File not found");
    }
    if (!existsSync(target)) {
      throw new NotFoundException("File not found");
    }
    return target;
  }

  mapForClient(row: ImageEditHistory): ImageEditClientJob {
    const options = row.options ?? {};
    const files = (options.files ?? []).map((file) => this.mapFile(row.id, file));
    return {
      id: row.id,
      feature: row.feature,
      displayName: row.displayName,
      status: row.status,
      inputUrl: row.inputFileName ? this.fileUrl(row.id, row.inputFileName) : null,
      resultUrl: row.resultFileName ? this.fileUrl(row.id, row.resultFileName) : null,
      files,
      detections: options.detections ?? [],
      scale: options.scale ?? null,
      domain: options.domain ?? null,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private mapFile(historyId: string, file: ImageEditFileMeta): ImageEditClientFile {
    return {
      name: file.name,
      url: this.fileUrl(historyId, file.name),
      ...(file.label ? { label: file.label } : {}),
      ...(file.confidence != null ? { confidence: file.confidence } : {}),
    };
  }

  private fileUrl(historyId: string, filename: string): string {
    return `/api/tools/image-edit/files/${encodeURIComponent(historyId)}/${encodeURIComponent(filename)}`;
  }

  contentType(filename: string): string {
    const extension = extname(filename).toLowerCase();
    if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
    if (extension === ".webp") return "image/webp";
    if (extension === ".zip") return "application/zip";
    return "image/png";
  }
}
