import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { Not, IsNull, Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { NotificationsService } from "../notifications/notifications.service";
import { AnalyzeWhiteboardDto } from "./dto/analyze-whiteboard.dto";
import { RenderWhiteboardDto } from "./dto/render-whiteboard.dto";
import { WhiteboardHistory } from "./whiteboard-history.entity";
import {
  normalizeSceneObjects,
  readSceneObjects,
  WhiteboardObject,
  WhiteboardSceneJson,
} from "./whiteboard-scene";

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

  private saveSourceImage(file: Express.Multer.File): { assetsDir: string; fileName: string } {
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

  /**
   * Step 1 of the review flow: persist the upload and open a draft row. The draft
   * stays out of the render queue (and out of history) until the reviewer accepts
   * the detected scene and calls `enqueueReviewed`.
   */
  async createAnalysisDraft(
    dto: AnalyzeWhiteboardDto,
    file: Express.Multer.File,
  ): Promise<WhiteboardHistory> {
    const userId = dto.userId?.trim();
    if (!userId) throw new BadRequestException("userId is required");

    const { assetsDir, fileName } = this.saveSourceImage(file);
    const displayName =
      dto.displayName?.trim() || `Whiteboard — ${new Date().toISOString().slice(0, 10)}`;

    const draft = this.repository.create({
      userId,
      nodeId: dto.nodeId?.trim() || null,
      displayName,
      assetsDir,
      sourceImageFileName: fileName,
      status: QueueJobStatus.PENDING,
    } as Partial<WhiteboardHistory>);

    return (await this.repository.save(draft)) as WhiteboardHistory;
  }

  /** Persist canvas size after upload — boxes are drawn manually on the FE. */
  async savePreparedCanvas(id: string, imageWidth: number, imageHeight: number): Promise<void> {
    await this.repository.update(
      { id },
      {
        imageWidth,
        imageHeight,
        sceneJson: { imageWidth, imageHeight, objects: [] } as never,
        analyzedAt: new Date(),
      },
    );
  }

  /** Persist a freshly detected / reviewed scene. */
  async saveAnalyzedScene(id: string, scene: WhiteboardSceneJson): Promise<void> {
    await this.repository.update(
      { id },
      {
        sceneJson: scene as never,
        imageWidth: scene.imageWidth,
        imageHeight: scene.imageHeight,
        analyzedAt: new Date(),
      },
    );
  }

  /**
   * Re-validate a reviewer-edited object list against the stored image size.
   * Client payloads are never trusted: boxes are clamped, ids de-duplicated and
   * the order resequenced before anything reaches the path planner.
   */
  async applyReviewedScene(
    history: WhiteboardHistory,
    objects: unknown,
  ): Promise<WhiteboardSceneJson> {
    const imageWidth = history.imageWidth ?? 0;
    const imageHeight = history.imageHeight ?? 0;
    if (imageWidth <= 0 || imageHeight <= 0) {
      throw new BadRequestException("Analysis has no image dimensions — re-run analyze first");
    }

    const normalized = normalizeSceneObjects(objects, imageWidth, imageHeight);
    if (normalized.length === 0) {
      throw new BadRequestException("Keep at least one object to render");
    }

    const scene: WhiteboardSceneJson = { imageWidth, imageHeight, objects: normalized };
    await this.repository.update({ id: history.id }, { sceneJson: scene as never });
    return scene;
  }

  /** Step 2 of the review flow: queue the render for an already-analyzed draft. */
  async enqueueReviewed(dto: RenderWhiteboardDto): Promise<WhiteboardHistory> {
    const userId = dto.userId?.trim();
    const analysisId = dto.analysisId?.trim();
    if (!userId) throw new BadRequestException("userId is required");
    if (!analysisId) throw new BadRequestException("analysisId is required");

    const history = await this.repository.findOne({ where: { id: analysisId, userId } });
    if (!history) throw new NotFoundException("Whiteboard analysis not found");
    if (history.status === QueueJobStatus.RUNNING) {
      throw new BadRequestException("This analysis is already rendering");
    }

    await this.applyReviewedScene(history, dto.objects);

    const patch: Partial<WhiteboardHistory> = {
      status: QueueJobStatus.PENDING,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
      renderStartedAt: null,
      renderFinishedAt: null,
      renderDurationMs: null,
    };
    if (dto.displayName?.trim()) patch.displayName = dto.displayName.trim();
    if (dto.engineConfig) {
      patch.engineConfig = dto.engineConfig as unknown as Record<string, unknown>;
    }
    await this.repository.update({ id: analysisId }, patch as never);

    const queueJob = await this.queue.add(
      WHITEBOARD_QUEUE_NAME,
      { whiteboardHistoryId: analysisId },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );
    await this.repository.update(
      { id: analysisId },
      { queueJobId: queueJob.id ? String(queueJob.id) : null },
    );

    const queued = await this.repository.findOne({ where: { id: analysisId } });
    return queued as WhiteboardHistory;
  }

  async getById(id: string): Promise<WhiteboardHistory | null> {
    return this.repository.findOne({ where: { id } });
  }

  async getOwnedById(id: string, userId: string): Promise<WhiteboardHistory> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const row = await this.repository.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("Whiteboard analysis not found");
    return row;
  }

  /** Only rows that reached the queue; analyze-only drafts stay hidden. */
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
      .where("h.user_id = :userId", { userId: userId.trim() })
      .andWhere("h.queue_job_id IS NOT NULL");

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
    const row = await this.getOwnedById(id, userId);
    this.safeRemoveArtifacts(row);
    await this.repository.delete({ id, userId: userId.trim() });
    return { deleted: true, id };
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const rows = await this.repository.find({
      where: { userId: userId.trim(), queueJobId: Not(IsNull()) },
    });
    for (const row of rows) this.safeRemoveArtifacts(row);
    const result = await this.repository.delete({
      userId: userId.trim(),
      queueJobId: Not(IsNull()),
    });
    return { deleted: result.affected ?? rows.length };
  }

  /** Remove both the render work dir and the uploaded source image. */
  private safeRemoveArtifacts(row: WhiteboardHistory): void {
    const dirs = [join(this.resolveWorkRoot(), row.id)];
    if (row.assetsDir) dirs.push(row.assetsDir);
    for (const dir of dirs) {
      try {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        this.logger.warn(`Failed to remove ${dir} for ${row.id}: ${String(err)}`);
      }
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
      scene: this.mapScene(row),
      analyzedAt: row.analyzedAt,
      engineConfig: row.engineConfig,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      renderStartedAt: row.renderStartedAt,
      renderFinishedAt: row.renderFinishedAt,
      renderDurationMs: row.renderDurationMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      sourceImageUrl: `/api/tools/whiteboard/source-image?whiteboardHistoryId=${row.id}`,
      playUrl,
      downloadUrl: playUrl,
    };
  }

  /** Expose only the reviewable scene; never the server-side upload path. */
  private mapScene(row: WhiteboardHistory): WhiteboardSceneJson | null {
    const raw = row.sceneJson as Record<string, unknown> | null;
    const objects = readSceneObjects(raw);
    if (!objects) return null;
    return {
      imageWidth: Number(raw?.imageWidth ?? row.imageWidth ?? 0),
      imageHeight: Number(raw?.imageHeight ?? row.imageHeight ?? 0),
      objects: objects as WhiteboardObject[],
    };
  }

  resolveSourceImagePath(history: WhiteboardHistory): string {
    if (!history.assetsDir || !history.sourceImageFileName) {
      throw new NotFoundException("Whiteboard source image not found");
    }
    const filePath = join(history.assetsDir, history.sourceImageFileName);
    if (!existsSync(filePath)) throw new NotFoundException("Whiteboard source image not found");
    return filePath;
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
      {
        status: QueueJobStatus.RUNNING,
        errorMessage: null,
        renderStartedAt: new Date(),
        renderFinishedAt: null,
        renderDurationMs: null,
      },
    );
  }

  async processCompleted(id: string, resultPath: string): Promise<void> {
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update(
      { id },
      {
        status: QueueJobStatus.COMPLETED,
        resultPath,
        resultFileName: basename(resultPath),
        errorMessage: null,
        ...timing,
      },
    );
    const history = await this.repository.findOne({
      where: { id },
      select: { id: true, userId: true, displayName: true },
    });
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

  async updatePathPlan(id: string, pathPlan: Record<string, unknown>): Promise<void> {
    await this.repository.update({ id }, { pathPlan: pathPlan as never });
  }

  async updateRuntimeMessage(id: string, message: string): Promise<void> {
    await this.repository.update({ id }, { errorMessage: message });
  }

  private async resolveRenderTiming(id: string): Promise<{
    renderFinishedAt: Date;
    renderDurationMs: number;
  }> {
    const row = await this.repository.findOne({
      where: { id },
      select: { id: true, createdAt: true, renderStartedAt: true },
    });
    const renderFinishedAt = new Date();
    const startedAt = row?.renderStartedAt ?? row?.createdAt ?? renderFinishedAt;
    return {
      renderFinishedAt,
      renderDurationMs: Math.max(0, renderFinishedAt.getTime() - startedAt.getTime()),
    };
  }
}
