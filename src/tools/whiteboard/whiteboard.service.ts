import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { NotificationsService } from "../notifications/notifications.service";
import { RenderWhiteboardUploadDto } from "./dto/render-whiteboard-upload.dto";
import { WhiteboardHistory } from "./whiteboard-history.entity";

export const WHITEBOARD_QUEUE_NAME = "video-whiteboard";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);

export interface WhiteboardEngineConfig {
  fps?: number;
  durationSec?: number;
  brushSize?: number;
  brushSpeedPx?: number;
}

@Injectable()
export class WhiteboardService {
  private readonly logger = new Logger(WhiteboardService.name);

  constructor(
    @InjectQueue(WHITEBOARD_QUEUE_NAME)
    private readonly queue: Queue,
    @InjectRepository(WhiteboardHistory, "tool")
    private readonly repository: Repository<WhiteboardHistory>,
    private readonly notificationsService: NotificationsService,
  ) {}

  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.WHITEBOARD_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cmdTimeout = Number(process.env.WHITEBOARD_CMD_TIMEOUT_MS ?? 1_800_000);
    return cmdTimeout + 120_000;
  }

  resolveWorkRoot(): string {
    return resolve(process.cwd(), process.env.WHITEBOARD_WORK_ROOT ?? "uploads/whiteboard");
  }

  prepareWorkDir(id: string): string {
    const workDir = join(this.resolveWorkRoot(), id);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "output"), { recursive: true });
    return workDir;
  }

  saveSourceImage(file: Express.Multer.File): { assetsDir: string; fileName: string } {
    if (!IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported image type: ${file.mimetype}`);
    }
    const assetsDir = join(this.resolveWorkRoot(), "_uploads", randomUUID());
    mkdirSync(assetsDir, { recursive: true });
    const ext = extname(file.originalname).toLowerCase() || ".png";
    const fileName = `source${ext}`;
    writeFileSync(join(assetsDir, fileName), file.buffer);
    return { assetsDir, fileName };
  }

  parseEngineConfig(raw: string | undefined): WhiteboardEngineConfig {
    if (!raw?.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      return parsed as WhiteboardEngineConfig;
    } catch {
      throw new BadRequestException("engineConfig must be a valid JSON object string");
    }
  }

  async enqueueFromUpload(
    dto: RenderWhiteboardUploadDto,
    file: Express.Multer.File,
  ): Promise<WhiteboardHistory> {
    const userId = dto.userId?.trim();
    if (!userId) throw new BadRequestException("userId is required");

    const engineConfig = this.parseEngineConfig(dto.engineConfig);
    const { assetsDir, fileName } = this.saveSourceImage(file);

    const displayName = dto.displayName?.trim() || `Whiteboard — ${new Date().toISOString().slice(0, 10)}`;

    const history = this.repository.create({
      userId,
      nodeId: dto.nodeId?.trim() ?? null,
      displayName,
      sourceImageFileName: fileName,
      imageWidth: null,
      imageHeight: null,
      sceneJson: { assetsDir } as Record<string, unknown>,
      pathPlan: null,
      engineConfig: engineConfig as Record<string, unknown>,
      status: QueueJobStatus.PENDING,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
      queueJobId: null,
      renderStartedAt: null,
      renderFinishedAt: null,
      renderDurationMs: null,
    } as Partial<WhiteboardHistory>);
    const created = await this.repository.save(history);

    const queueJob = await this.queue.add(
      WHITEBOARD_QUEUE_NAME,
      { whiteboardHistoryId: (created as WhiteboardHistory).id },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );

    (created as WhiteboardHistory).queueJobId = queueJob.id ? String(queueJob.id) : null;
    return this.repository.save(created as WhiteboardHistory);
  }

  async getById(id: string): Promise<WhiteboardHistory | null> {
    return this.repository.findOne({ where: { id } });
  }

  async listHistory(
    userId: string,
    page = 1,
    limit = 20,
    search?: string,
  ): Promise<{
    items: ReturnType<WhiteboardService["mapForClient"]>[];
    total: number;
    page: number;
    limit: number;
    hasMore: boolean;
  }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const take = Math.min(Math.max(1, Math.trunc(limit) || 20), 50);
    const currentPage = Math.max(1, Math.trunc(page) || 1);
    const skip = (currentPage - 1) * take;
    const keyword = search?.trim() ?? "";

    const qb = this.repository
      .createQueryBuilder("h")
      .where("h.user_id = :userId", { userId: userId.trim() });

    if (keyword) {
      qb.andWhere("h.display_name ILIKE :keyword", { keyword: `%${keyword}%` });
    }

    const [rows, total] = await qb
      .orderBy("h.created_at", "DESC")
      .take(take)
      .skip(skip)
      .getManyAndCount();

    return {
      items: rows.map((row) => this.mapForClient(row)),
      total,
      page: currentPage,
      limit: take,
      hasMore: skip + rows.length < total,
    };
  }

  async deleteHistory(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const row = await this.repository.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Whiteboard history not found");
    this.safeRemoveWorkDir(id);
    await this.repository.delete({ id, userId: userId.trim() });
    return { deleted: true, id };
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const rows = await this.repository.find({ where: { userId: userId.trim() } });
    for (const row of rows) this.safeRemoveWorkDir(row.id);
    const result = await this.repository.delete({ userId: userId.trim() });
    return { deleted: result.affected ?? rows.length };
  }

  private safeRemoveWorkDir(id: string): void {
    try {
      const dir = join(this.resolveWorkRoot(), id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`Failed to remove work dir for ${id}: ${String(err)}`);
    }
  }

  mapForClient(row: WhiteboardHistory) {
    const playUrl = row.resultPath
      ? `/api/tools/whiteboard/artifact?whiteboardHistoryId=${row.id}`
      : null;
    return {
      id: row.id,
      userId: row.userId,
      nodeId: row.nodeId,
      displayName: row.displayName,
      status: row.status,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      sceneJson: row.sceneJson,
      engineConfig: row.engineConfig,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      renderStartedAt: row.renderStartedAt,
      renderFinishedAt: row.renderFinishedAt,
      renderDurationMs: row.renderDurationMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      playUrl,
      downloadUrl: playUrl,
    };
  }

  resolveArtifactPath(history: WhiteboardHistory): string {
    if (history.resultPath && existsSync(history.resultPath)) return history.resultPath;
    const fallback = join(this.resolveWorkRoot(), history.id, "output", "whiteboard.mp4");
    if (existsSync(fallback)) return fallback;
    throw new NotFoundException("Whiteboard output not found");
  }

  async processStarted(id: string): Promise<void> {
    await this.repository.update(
      { id },
      { status: QueueJobStatus.RUNNING, errorMessage: null, renderStartedAt: new Date(), renderFinishedAt: null, renderDurationMs: null },
    );
  }

  async processCompleted(id: string, resultPath: string): Promise<void> {
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update(
      { id },
      { status: QueueJobStatus.COMPLETED, resultPath, resultFileName: basename(resultPath), errorMessage: null, ...timing },
    );
    const history = await this.repository.findOne({ where: { id }, select: { id: true, userId: true, displayName: true } });
    if (history?.userId) {
      try {
        await this.notificationsService.pushSuccess(
          history.userId,
          "Whiteboard hoàn tất",
          `Video "${history.displayName}" đã sẵn sàng.`,
        );
      } catch (err) {
        this.logger.warn(`Failed to push whiteboard success notification: ${String(err)}`);
      }
    }
  }

  async processFailed(id: string, errorMessage: string): Promise<void> {
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update({ id }, { status: QueueJobStatus.FAILED, errorMessage, ...timing });
  }

  async updateSceneJson(id: string, sceneJson: Record<string, unknown>): Promise<void> {
    await this.repository.update({ id }, { sceneJson: sceneJson as never });
  }

  async updatePathPlan(id: string, pathPlan: Record<string, unknown>): Promise<void> {
    await this.repository.update({ id }, { pathPlan: pathPlan as never });
  }

  async updateImageDimensions(id: string, width: number, height: number): Promise<void> {
    await this.repository.update({ id }, { imageWidth: width, imageHeight: height });
  }

  async updateRuntimeMessage(id: string, message: string): Promise<void> {
    await this.repository.update({ id }, { errorMessage: message });
  }

  private async resolveRenderTiming(id: string): Promise<{ renderFinishedAt: Date; renderDurationMs: number }> {
    const row = await this.repository.findOne({ where: { id }, select: { id: true, createdAt: true, renderStartedAt: true } });
    const renderFinishedAt = new Date();
    const startedAt = row?.renderStartedAt ?? row?.createdAt ?? renderFinishedAt;
    return { renderFinishedAt, renderDurationMs: Math.max(0, renderFinishedAt.getTime() - startedAt.getTime()) };
  }
}
