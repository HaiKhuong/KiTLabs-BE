import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, unlinkSync } from "fs";
import { basename, extname, join, resolve } from "path";
import { Not, IsNull, Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { resolveWhiteboardWorkRoot } from "../../common/desktop/data-path";
import {
  CANCELLED_BY_USER_MESSAGE,
  type CancelRenderResult,
  discardQueueJob,
  RenderJobKeys,
  shouldDeleteRenderFiles,
} from "../../common/process/render-cancel";
import { RenderProcessRegistry } from "../../common/process/render-process-registry";
import { NotificationsService } from "../notifications/notifications.service";
import { LogsService } from "../logs/logs.service";
import { AnalyzeWhiteboardDto } from "./dto/analyze-whiteboard.dto";
import { MergeWhiteboardDto } from "./dto/merge-whiteboard.dto";
import { RenderWhiteboardDto } from "./dto/render-whiteboard.dto";
import { WhiteboardHistory } from "./whiteboard-history.entity";
import {
  MERGE_SLIDE_TRANSITIONS,
  type MergeSlideTransition,
} from "./whiteboard-merge.service";
import { WhiteboardRecentsService } from "./whiteboard-recents.service";
import {
  normalizeSceneObjects,
  readSceneObjects,
  WhiteboardObject,
  WhiteboardSceneJson,
} from "./whiteboard-scene";

export const WHITEBOARD_QUEUE_NAME = "video-whiteboard";

const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp"]);
const HAND_IMAGE_MIME = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "image/svg+xml",
]);

export interface WhiteboardEngineConfig {
  fps?: number;
  durationSec?: number;
  brushSize?: number;
  brushSpeedPx?: number;
  /** When true, render uses the user's uploaded hand image if present. */
  useCustomHand?: boolean;
  cameraZooms?: Array<{ storyboardIndices: number[] }>;
  /** Recent-image ids placed on this scene (copied under assetsDir/selected). */
  selectedRecentIds?: string[];
  /** whiteboard_idea_histories id — used to overwrite the same project scene/merge. */
  ideaHistoryId?: string;
  sceneIndex?: number;
  kind?: "scene" | "merge";
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
    private readonly recentsService: WhiteboardRecentsService,
    private readonly renderProcessRegistry: RenderProcessRegistry,
    private readonly logsService: LogsService,
  ) {}

  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.WHITEBOARD_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    return 1_920_000;
  }

  resolveWorkRoot(): string {
    return resolveWhiteboardWorkRoot();
  }

  prepareWorkDir(id: string): string {
    const workDir = join(this.resolveWorkRoot(), id);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "output"), { recursive: true });
    return workDir;
  }

  resolveHandsRoot(): string {
    return join(this.resolveWorkRoot(), "_hands");
  }

  resolveUserHandDir(userId: string): string {
    const safe = userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "anon";
    return join(this.resolveHandsRoot(), safe);
  }

  /** Save/replace the custom hand image for a user. Returns stored fileName. */
  saveHandImage(userId: string, file: Express.Multer.File): { fileName: string } {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    if (!file?.buffer?.length) throw new BadRequestException("file is required");
    if (!HAND_IMAGE_MIME.has(file.mimetype)) {
      throw new BadRequestException(`Unsupported hand image type: ${file.mimetype}`);
    }

    const dir = this.resolveUserHandDir(uid);
    mkdirSync(dir, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (name.startsWith("hand.")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore
        }
      }
    }

    let ext = extname(file.originalname).toLowerCase();
    if (!ext) {
      if (file.mimetype === "image/svg+xml") ext = ".svg";
      else if (file.mimetype === "image/webp") ext = ".webp";
      else if (file.mimetype === "image/jpeg" || file.mimetype === "image/jpg") ext = ".jpg";
      else ext = ".png";
    }
    const fileName = `hand${ext}`;
    writeFileSync(join(dir, fileName), file.buffer);
    return { fileName };
  }

  /** Absolute path to the user's custom hand image, or null. */
  resolveHandImagePath(userId: string): string | null {
    const uid = userId?.trim();
    if (!uid) return null;
    const dir = this.resolveUserHandDir(uid);
    if (!existsSync(dir)) return null;
    const match = readdirSync(dir).find((name) => /^hand\.(png|jpe?g|webp|svg)$/i.test(name));
    if (!match) return null;
    const full = join(dir, match);
    return existsSync(full) ? full : null;
  }

  clearHandImage(userId: string): void {
    const uid = userId?.trim();
    if (!uid) throw new BadRequestException("userId is required");
    const dir = this.resolveUserHandDir(uid);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (name.startsWith("hand.")) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          // ignore
        }
      }
    }
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

  private async findReusableHistory(opts: {
    userId: string;
    ideaHistoryId: string;
    kind: "scene" | "merge";
    sceneIndex?: number;
  }): Promise<WhiteboardHistory | null> {
    const qb = this.repository
      .createQueryBuilder("h")
      .where("h.user_id = :userId", { userId: opts.userId })
      .andWhere("h.engine_config->>'ideaHistoryId' = :ideaHistoryId", {
        ideaHistoryId: opts.ideaHistoryId,
      });

    if (opts.kind === "merge") {
      qb.andWhere("h.engine_config->>'kind' = 'merge'");
    } else {
      qb.andWhere("COALESCE(h.engine_config->>'kind', 'scene') <> 'merge'");
      qb.andWhere("(h.engine_config->>'sceneIndex')::int = :sceneIndex", {
        sceneIndex: opts.sceneIndex ?? 0,
      });
    }

    return qb.orderBy("h.updated_at", "DESC").getOne();
  }

  private assertHistoryIdleForReuse(row: WhiteboardHistory): void {
    if (row.status === QueueJobStatus.RUNNING) {
      throw new ConflictException(
        "Dự án này đang render — đợi xong hoặc hủy trước khi render lại",
      );
    }
  }

  /**
   * Step 1 of the review flow: persist the upload and open a draft row. The draft
   * stays out of the render queue (and out of history) until the reviewer accepts
   * the detected scene and calls `enqueueReviewed`.
   *
   * When `ideaHistoryId` + `sceneIndex` are set, reuse the existing scene row so
   * a re-render of the same project overwrites the previous history.
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
    const ideaHistoryId = dto.ideaHistoryId?.trim() || "";
    const sceneIndex = Number.isFinite(Number(dto.sceneIndex)) ? Number(dto.sceneIndex) : 0;
    const identityConfig = ideaHistoryId
      ? { ideaHistoryId, sceneIndex, kind: "scene" as const }
      : {};

    if (ideaHistoryId) {
      const existing = await this.findReusableHistory({
        userId,
        ideaHistoryId,
        kind: "scene",
        sceneIndex,
      });
      if (existing) {
        this.assertHistoryIdleForReuse(existing);
        await discardQueueJob(this.queue, existing.queueJobId);
        if (existing.assetsDir && existing.assetsDir !== assetsDir) {
          try {
            rmSync(existing.assetsDir, { recursive: true, force: true });
          } catch {
            // ignore leftover upload dir
          }
        }
        await this.repository.update(
          { id: existing.id },
          {
            nodeId: dto.nodeId?.trim() || null,
            displayName,
            assetsDir,
            sourceImageFileName: fileName,
            imageWidth: null,
            imageHeight: null,
            sceneJson: null,
            pathPlan: null,
            analyzedAt: null,
            engineConfig: identityConfig as never,
            status: QueueJobStatus.PENDING,
            resultPath: null,
            resultFileName: null,
            errorMessage: null,
            queueJobId: null,
            renderStartedAt: null,
            renderFinishedAt: null,
            renderDurationMs: null,
          } as never,
        );
        const reused = await this.repository.findOne({ where: { id: existing.id } });
        return reused as WhiteboardHistory;
      }
    }

    const draft = this.repository.create({
      userId,
      nodeId: dto.nodeId?.trim() || null,
      displayName,
      assetsDir,
      sourceImageFileName: fileName,
      status: QueueJobStatus.PENDING,
      engineConfig: Object.keys(identityConfig).length > 0 ? (identityConfig as never) : null,
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

  /** Persist per-layer PNGs from render payload so overlapping reveals keep correct z-order. */
  persistObjectLayerSources(
    historyId: string,
    rawObjects: unknown,
    normalizedObjects: WhiteboardObject[],
  ): Record<string, string> {
    if (!Array.isArray(rawObjects) || normalizedObjects.length === 0) return {};

    const sourceById = new Map<string, string>();
    for (const entry of rawObjects) {
      if (!entry || typeof entry !== "object") continue;
      const row = entry as Record<string, unknown>;
      const id = String(row.id ?? "").trim();
      const dataUrl = String(row.layerSourceDataUrl ?? "").trim();
      if (!id || !dataUrl.startsWith("data:image/")) continue;
      sourceById.set(id, dataUrl);
    }
    if (sourceById.size === 0) return {};

    const workDir = this.prepareWorkDir(historyId);
    const layerDir = join(workDir, "layers");
    mkdirSync(layerDir, { recursive: true });

    const paths: Record<string, string> = {};
    for (const obj of normalizedObjects) {
      const dataUrl = sourceById.get(obj.id);
      if (!dataUrl) continue;
      const filePath = join(layerDir, `${obj.id}.png`);
      try {
        this.writeDataUrlToFile(dataUrl, filePath);
        paths[obj.id] = filePath;
      } catch (error) {
        this.logger.warn(
          `[${historyId}] Failed to persist layer source for ${obj.id}: ${String(error)}`,
        );
      }
    }
    return paths;
  }

  private writeDataUrlToFile(dataUrl: string, filePath: string): void {
    const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
    if (!match) throw new Error("Invalid data URL");
    writeFileSync(filePath, Buffer.from(match[2], "base64"));
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

    const scene = await this.applyReviewedScene(history, dto.objects);
    const objectLayerSourcePaths = this.persistObjectLayerSources(
      analysisId,
      dto.objects,
      scene.objects,
    );
    if (Object.keys(objectLayerSourcePaths).length === 0) {
      this.logger.warn(
        `[${analysisId}] No per-layer sources persisted — overlap reveals may leak sibling pixels`,
      );
    } else {
      this.logger.log(
        `[${analysisId}] Persisted ${Object.keys(objectLayerSourcePaths).length} isolated layer source(s)`,
      );
    }

    const selectedRecentIds = Array.isArray(dto.engineConfig?.selectedRecentIds)
      ? dto.engineConfig.selectedRecentIds.map((id) => String(id ?? "").trim()).filter(Boolean)
      : [];
    let selectedAssets: Array<{ id: string; originalName: string; fileName: string }> = [];
    if (selectedRecentIds.length > 0) {
      const assetsDir =
        history.assetsDir?.trim() ||
        (() => {
          const dir = join(this.resolveWorkRoot(), "_uploads", randomUUID());
          mkdirSync(dir, { recursive: true });
          return dir;
        })();
      if (!history.assetsDir) {
        await this.repository.update({ id: analysisId }, { assetsDir });
        history.assetsDir = assetsDir;
      }
      selectedAssets = await this.recentsService.copyOwnedToDir(
        userId,
        selectedRecentIds,
        join(assetsDir, "selected"),
      );
    }

    await discardQueueJob(this.queue, history.queueJobId);

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
    const priorConfig = (history.engineConfig ?? {}) as WhiteboardEngineConfig;
    const nextEngineConfig = {
      ...(history.engineConfig ?? {}),
      ...(dto.engineConfig ?? {}),
      ...(Object.keys(objectLayerSourcePaths).length > 0 ? { objectLayerSourcePaths } : {}),
      ...(selectedAssets.length > 0
        ? { selectedRecentIds, selectedAssets }
        : selectedRecentIds.length > 0
          ? { selectedRecentIds }
          : {}),
      ...(priorConfig.ideaHistoryId
        ? { ideaHistoryId: priorConfig.ideaHistoryId, sceneIndex: priorConfig.sceneIndex, kind: priorConfig.kind ?? "scene" }
        : {}),
    };
    patch.engineConfig = nextEngineConfig as Record<string, unknown>;
    await this.repository.update({ id: analysisId }, patch as never);

    this.renderProcessRegistry.begin(RenderJobKeys.whiteboard(analysisId));
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
    void this.logsService.logRender({
      userId,
      feature: "whiteboard",
      historyId: analysisId,
      displayName: queued?.displayName ?? dto.displayName ?? null,
      data: {
        kind: "scene",
        analysisId,
        objects: dto.objects,
        engineConfig: queued?.engineConfig ?? nextEngineConfig,
        imageWidth: queued?.imageWidth ?? history.imageWidth,
        imageHeight: queued?.imageHeight ?? history.imageHeight,
      },
    });
    return queued as WhiteboardHistory;
  }

  /** Queue an FFmpeg xfade merge of completed scene histories. */
  async enqueueMerge(dto: MergeWhiteboardDto): Promise<WhiteboardHistory> {
    const userId = dto.userId?.trim();
    if (!userId) throw new BadRequestException("userId is required");

    const historyIds = (dto.historyIds ?? [])
      .map((id) => String(id ?? "").trim())
      .filter(Boolean);
    if (historyIds.length < 2) {
      throw new BadRequestException("Cần ít nhất 2 video để gộp");
    }
    if (new Set(historyIds).size !== historyIds.length) {
      throw new BadRequestException("historyIds không được trùng");
    }

    const transitions = (dto.transitions ?? []) as MergeSlideTransition[];
    if (transitions.length !== historyIds.length - 1) {
      throw new BadRequestException("Số transition phải bằng số mối nối (N-1)");
    }
    for (const transition of transitions) {
      if (!(MERGE_SLIDE_TRANSITIONS as readonly string[]).includes(transition)) {
        throw new BadRequestException(`Transition không hợp lệ: ${transition}`);
      }
    }

    const sources: WhiteboardHistory[] = [];
    for (const id of historyIds) {
      const row = await this.repository.findOne({ where: { id, userId } });
      if (!row) throw new NotFoundException(`Không tìm thấy video: ${id}`);
      if (row.status !== QueueJobStatus.COMPLETED || !row.resultPath) {
        throw new BadRequestException(`Video chưa render xong: ${row.displayName || id}`);
      }
      if (!existsSync(row.resultPath)) {
        throw new BadRequestException(`Thiếu file output: ${row.displayName || id}`);
      }
      sources.push(row);
    }

    const displayName =
      dto.displayName?.trim() ||
      `Gộp · ${sources.map((row) => row.displayName).join(" + ").slice(0, 180)}`;

    const summaryEnabled = Boolean(dto.summary?.enabled && dto.summary?.imageDataUrl?.startsWith("data:image/"));
    const summaryDurationSec = Math.min(
      30,
      Math.max(0.5, Number(dto.summary?.durationSec) || 3),
    );
    const summaryTransition =
      dto.summary?.transition &&
      (MERGE_SLIDE_TRANSITIONS as readonly string[]).includes(dto.summary.transition)
        ? dto.summary.transition
        : ("slide_left" as MergeSlideTransition);

    const ideaHistoryId = dto.ideaHistoryId?.trim() || "";
    const mergeEngineConfig = {
      kind: "merge" as const,
      ...(ideaHistoryId ? { ideaHistoryId } : {}),
      sourceHistoryIds: historyIds,
      transitions,
      ...(summaryEnabled
        ? {
            summary: {
              enabled: true,
              durationSec: summaryDurationSec,
              transition: summaryTransition,
              frames: dto.summary?.frames ?? [],
            },
          }
        : {}),
    };

    let saved: WhiteboardHistory;
    if (ideaHistoryId) {
      const existing = await this.findReusableHistory({
        userId,
        ideaHistoryId,
        kind: "merge",
      });
      if (existing) {
        this.assertHistoryIdleForReuse(existing);
        await discardQueueJob(this.queue, existing.queueJobId);
        await this.repository.update(
          { id: existing.id },
          {
            displayName,
            assetsDir: null,
            sourceImageFileName: null,
            imageWidth: sources[0]?.imageWidth ?? 1920,
            imageHeight: sources[0]?.imageHeight ?? 1080,
            sceneJson: {
              imageWidth: sources[0]?.imageWidth ?? 1920,
              imageHeight: sources[0]?.imageHeight ?? 1080,
              objects: [],
            } as never,
            analyzedAt: new Date(),
            engineConfig: mergeEngineConfig as never,
            status: QueueJobStatus.PENDING,
            resultPath: null,
            resultFileName: null,
            errorMessage: null,
            queueJobId: null,
            renderStartedAt: null,
            renderFinishedAt: null,
            renderDurationMs: null,
          } as never,
        );
        saved = (await this.repository.findOne({ where: { id: existing.id } })) as WhiteboardHistory;
      } else {
        saved = (await this.repository.save(
          this.repository.create({
            userId,
            nodeId: null,
            displayName,
            assetsDir: null,
            sourceImageFileName: null,
            imageWidth: sources[0]?.imageWidth ?? 1920,
            imageHeight: sources[0]?.imageHeight ?? 1080,
            sceneJson: {
              imageWidth: sources[0]?.imageWidth ?? 1920,
              imageHeight: sources[0]?.imageHeight ?? 1080,
              objects: [],
            } as never,
            analyzedAt: new Date(),
            engineConfig: mergeEngineConfig as never,
            status: QueueJobStatus.PENDING,
            resultPath: null,
            resultFileName: null,
            errorMessage: null,
          } as Partial<WhiteboardHistory>),
        )) as WhiteboardHistory;
      }
    } else {
      saved = (await this.repository.save(
        this.repository.create({
          userId,
          nodeId: null,
          displayName,
          assetsDir: null,
          sourceImageFileName: null,
          imageWidth: sources[0]?.imageWidth ?? 1920,
          imageHeight: sources[0]?.imageHeight ?? 1080,
          sceneJson: {
            imageWidth: sources[0]?.imageWidth ?? 1920,
            imageHeight: sources[0]?.imageHeight ?? 1080,
            objects: [],
          } as never,
          analyzedAt: new Date(),
          engineConfig: mergeEngineConfig as never,
          status: QueueJobStatus.PENDING,
          resultPath: null,
          resultFileName: null,
          errorMessage: null,
        } as Partial<WhiteboardHistory>),
      )) as WhiteboardHistory;
    }

    if (summaryEnabled && dto.summary?.imageDataUrl) {
      const workDir = this.prepareWorkDir(saved.id);
      try {
        this.writeDataUrlToFile(dto.summary.imageDataUrl, join(workDir, "summary.png"));
        await this.repository.update(
          { id: saved.id },
          {
            engineConfig: {
              ...((saved.engineConfig ?? {}) as Record<string, unknown>),
              summary: {
                enabled: true,
                durationSec: summaryDurationSec,
                transition: summaryTransition,
                frames: dto.summary?.frames ?? [],
                imagePath: join(workDir, "summary.png"),
              },
            } as never,
          },
        );
      } catch (error) {
        this.logger.warn(`[${saved.id}] Failed to persist summary image: ${String(error)}`);
      }
    }

    this.renderProcessRegistry.begin(RenderJobKeys.whiteboard(saved.id));
    const queueJob = await this.queue.add(
      WHITEBOARD_QUEUE_NAME,
      { whiteboardHistoryId: saved.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );
    await this.repository.update(
      { id: saved.id },
      { queueJobId: queueJob.id ? String(queueJob.id) : null },
    );

    const queued = await this.repository.findOne({ where: { id: saved.id } });
    void this.logsService.logRender({
      userId,
      feature: "whiteboard",
      historyId: saved.id,
      displayName: queued?.displayName ?? displayName,
      data: {
        kind: "merge",
        historyIds,
        transitions,
        summary: dto.summary
          ? {
              enabled: dto.summary.enabled,
              durationSec: dto.summary.durationSec,
              transition: dto.summary.transition,
              frames: dto.summary.frames,
            }
          : null,
        engineConfig: queued?.engineConfig ?? mergeEngineConfig,
      },
    });
    return queued as WhiteboardHistory;
  }

  isMergeJob(history: WhiteboardHistory): boolean {
    const config = history.engineConfig as Record<string, unknown> | null;
    return config?.kind === "merge" && Array.isArray(config.sourceHistoryIds);
  }

  getMergeJobConfig(history: WhiteboardHistory): {
    sourceHistoryIds: string[];
    transitions: MergeSlideTransition[];
    summary: {
      enabled: boolean;
      durationSec: number;
      transition: MergeSlideTransition;
      imagePath: string | null;
    } | null;
  } {
    const config = (history.engineConfig ?? {}) as Record<string, unknown>;
    const sourceHistoryIds = Array.isArray(config.sourceHistoryIds)
      ? config.sourceHistoryIds.map((id) => String(id)).filter(Boolean)
      : [];
    const transitions = Array.isArray(config.transitions)
      ? (config.transitions as MergeSlideTransition[])
      : [];
    const rawSummary = config.summary;
    let summary: {
      enabled: boolean;
      durationSec: number;
      transition: MergeSlideTransition;
      imagePath: string | null;
    } | null = null;
    if (rawSummary && typeof rawSummary === "object") {
      const row = rawSummary as Record<string, unknown>;
      const imagePath = String(row.imagePath ?? "").trim() || null;
      const transition =
        typeof row.transition === "string" &&
        (MERGE_SLIDE_TRANSITIONS as readonly string[]).includes(row.transition)
          ? (row.transition as MergeSlideTransition)
          : ("slide_left" as MergeSlideTransition);
      summary = {
        enabled: Boolean(row.enabled) && Boolean(imagePath),
        durationSec: Math.min(30, Math.max(0.5, Number(row.durationSec) || 3)),
        transition,
        imagePath,
      };
    }
    return { sourceHistoryIds, transitions, summary };
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

  async cancel(id: string, userId: string): Promise<CancelRenderResult> {
    const row = await this.getOwnedById(id, userId);
    if (row.status !== QueueJobStatus.PENDING && row.status !== QueueJobStatus.RUNNING) {
      throw new ConflictException("Whiteboard job is not running");
    }

    this.renderProcessRegistry.requestCancel(RenderJobKeys.whiteboard(id));
    await discardQueueJob(this.queue, row.queueJobId);

    const deletedFiles = shouldDeleteRenderFiles();
    if (deletedFiles) {
      this.safeRemoveWorkDirOnly(row.id);
    }
    await this.markCancelled(id, deletedFiles);
    return { status: "cancelled", cancelled: true, deletedFiles };
  }

  async markCancelled(id: string, deletedFiles = shouldDeleteRenderFiles()): Promise<void> {
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update(
      { id },
      {
        status: QueueJobStatus.CANCELLED,
        errorMessage: CANCELLED_BY_USER_MESSAGE,
        queueJobId: null,
        ...timing,
        ...(deletedFiles ? { resultPath: null, resultFileName: null } : {}),
      },
    );
  }

  /** Remove render work dir but keep uploaded source image. */
  private safeRemoveWorkDirOnly(id: string): void {
    const dir = join(this.resolveWorkRoot(), id);
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`Failed to remove work dir for ${id}: ${String(err)}`);
    }
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
    const current = await this.repository.findOne({ where: { id }, select: { id: true, status: true } });
    if (!current || current.status === QueueJobStatus.CANCELLED) return;
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update({ id }, { status: QueueJobStatus.FAILED, errorMessage, ...timing });
  }

  async updatePathPlan(id: string, pathPlan: Record<string, unknown>): Promise<void> {
    await this.repository.update({ id }, { pathPlan: pathPlan as never });
  }

  async updateSceneAndEngineConfig(
    id: string,
    scene: WhiteboardSceneJson,
    engineConfig: Record<string, unknown>,
  ): Promise<void> {
    await this.repository.update({
      id,
    }, {
      sceneJson: scene as never,
      engineConfig: engineConfig as never,
    });
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
