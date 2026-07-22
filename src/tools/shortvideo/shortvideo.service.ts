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
import { CreateShortVideoJobDto } from "./dto/create-shortvideo-job.dto";
import { RenderShortVideoUploadDto } from "./dto/render-shortvideo-upload.dto";
import { ShortVideoHistory } from "./shortvideo-history.entity";

const UPLOAD_FIELDS = ["background", "left", "right", "voice", "sfx"] as const;
type UploadField = (typeof UPLOAD_FIELDS)[number];
type UploadedFiles = Partial<Record<UploadField, Express.Multer.File[]>>;

const DEFAULT_EXT: Record<UploadField, string> = {
  background: ".png",
  left: ".png",
  right: ".png",
  voice: ".mp3",
  sfx: ".mp3",
};

export const SHORTVIDEO_QUEUE_NAME = "video-shortvideo";

export type ShortVideoQueuedResponse = {
  jobId: string;
  nodeId: string;
  type: "short_video";
  status: "queued";
};

@Injectable()
export class ShortVideoService {
  private readonly logger = new Logger(ShortVideoService.name);

  constructor(
    @InjectQueue(SHORTVIDEO_QUEUE_NAME)
    private readonly shortVideoQueue: Queue,
    @InjectRepository(ShortVideoHistory, "tool")
    private readonly repository: Repository<ShortVideoHistory>,
    private readonly notificationsService: NotificationsService,
  ) {}

  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.SHORTVIDEO_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cmdTimeout = Number(process.env.SHORTVIDEO_CMD_TIMEOUT_MS ?? 1_800_000);
    return cmdTimeout + 120_000;
  }

  private resolveWorkRoot(): string {
    return resolve(process.cwd(), process.env.SHORTVIDEO_WORK_ROOT ?? "uploads/shortvideo");
  }

  private parseSpec(raw: string): Record<string, unknown> {
    let spec: unknown;
    try {
      spec = JSON.parse(raw);
    } catch {
      throw new BadRequestException("spec must be valid JSON");
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      throw new BadRequestException("spec must be a JSON object");
    }
    const scenes = (spec as Record<string, unknown>).scenes;
    if (!Array.isArray(scenes) || scenes.length === 0) {
      throw new BadRequestException("spec.scenes must be a non-empty array");
    }
    return spec as Record<string, unknown>;
  }

  async enqueue(dto: CreateShortVideoJobDto): Promise<ShortVideoHistory> {
    const userId = dto.userId?.trim();
    const nodeId = dto.nodeId?.trim();
    if (!userId) throw new BadRequestException("userId is required");
    if (!nodeId) throw new BadRequestException("nodeId is required");

    const spec = this.parseSpec(dto.spec);
    const title =
      dto.displayName?.trim() ||
      `ShortVideo — ${String((spec.left as Record<string, unknown>)?.title ?? "").trim() || "9:16"}`;

    if (dto.assetsDir?.trim()) {
      spec.assetsDir = dto.assetsDir.trim();
    }

    const history = this.repository.create({
      userId,
      nodeId,
      displayName: title,
      spec,
      engineConfig: dto.engineConfig ?? {},
      status: QueueJobStatus.PENDING,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
      queueJobId: null,
      renderStartedAt: null,
      renderFinishedAt: null,
      renderDurationMs: null,
    });
    const created = await this.repository.save(history);

    const queueJob = await this.shortVideoQueue.add(
      SHORTVIDEO_QUEUE_NAME,
      { shortVideoHistoryId: created.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );

    created.queueJobId = queueJob.id ? String(queueJob.id) : null;
    return this.repository.save(created);
  }

  /** Persist uploaded asset buffers into a fresh dir; return abs dir + saved filenames per field. */
  saveUploadAssets(files: UploadedFiles): {
    assetsDir: string;
    fileNames: Partial<Record<UploadField, string>>;
  } {
    const dir = join(this.resolveWorkRoot(), "_uploads", randomUUID());
    mkdirSync(dir, { recursive: true });
    const fileNames: Partial<Record<UploadField, string>> = {};
    for (const field of UPLOAD_FIELDS) {
      const file = files[field]?.[0];
      if (!file) continue;
      const ext = extname(file.originalname).toLowerCase() || DEFAULT_EXT[field];
      const name = `${field}${ext}`;
      writeFileSync(join(dir, name), file.buffer);
      fileNames[field] = name;
    }
    return { assetsDir: dir, fileNames };
  }

  /** Standalone menu flow: save uploaded assets, merge them into the spec, then enqueue. */
  async enqueueFromUpload(body: RenderShortVideoUploadDto, files: UploadedFiles): Promise<ShortVideoHistory> {
    const spec = this.parseSpec(body.spec);
    const { assetsDir, fileNames } = this.saveUploadAssets(files);

    if (fileNames.background) spec.background = fileNames.background;
    if (fileNames.voice) spec.voice = fileNames.voice;
    if (fileNames.sfx) spec.transitionSound = fileNames.sfx;
    if (fileNames.left) {
      const left = (spec.left as Record<string, unknown>) ?? {};
      spec.left = { ...left, image: fileNames.left };
    }
    if (fileNames.right) {
      const right = (spec.right as Record<string, unknown>) ?? {};
      spec.right = { ...right, image: fileNames.right };
    }

    let engineConfig: Record<string, unknown> = {};
    if (body.engineConfig?.trim()) {
      try {
        const parsed = JSON.parse(body.engineConfig);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          engineConfig = parsed as Record<string, unknown>;
        }
      } catch {
        throw new BadRequestException("engineConfig must be a valid JSON object string");
      }
    }

    const dto: CreateShortVideoJobDto = {
      userId: body.userId,
      nodeId: body.nodeId?.trim() || "menu",
      displayName: body.displayName,
      spec: JSON.stringify(spec),
      engineConfig,
      assetsDir,
    };
    return this.enqueue(dto);
  }

  async getById(id: string): Promise<ShortVideoHistory | null> {
    return this.repository.findOne({ where: { id } });
  }

  /** Paginated render history for a user, newest first. Optional `search` filters by name/topic. */
  async listHistory(
    userId: string,
    page = 1,
    limit = 20,
    search?: string,
  ): Promise<{
    items: ReturnType<ShortVideoService["mapForClient"]>[];
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
      qb.andWhere(
        `(
          h.display_name ILIKE :keyword
          OR COALESCE(h.result_file_name, '') ILIKE :keyword
          OR COALESCE(h.spec->>'topic', '') ILIKE :keyword
          OR COALESCE(h.spec->'left'->>'title', '') ILIKE :keyword
          OR COALESCE(h.spec->'right'->>'title', '') ILIKE :keyword
        )`,
        { keyword: `%${keyword}%` },
      );
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

  /** Delete a single history entry (and its work dir) owned by the user. */
  async deleteHistory(id: string, userId: string): Promise<{ deleted: boolean; id: string }> {
    if (!userId?.trim()) throw new BadRequestException("userId is required");
    const row = await this.repository.findOne({ where: { id, userId: userId.trim() } });
    if (!row) throw new NotFoundException("ShortVideo history not found");
    this.safeRemoveWorkDir(id);
    await this.repository.delete({ id, userId: userId.trim() });
    return { deleted: true, id };
  }

  /** Delete every history entry (and work dirs) for a user. */
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

  /**
   * Flatten caption entries ({time,text}) from the spec, preferring the new
   * per-scene `scenes[].captions` and falling back to a legacy top-level
   * `spec.captions` list. Empty texts are dropped.
   */
  static buildCaptionEntries(spec: Record<string, unknown> | null | undefined): { time: number; text: string }[] {
    const src = (spec ?? {}) as Record<string, unknown>;
    const scenes = Array.isArray(src.scenes) ? src.scenes : [];
    const nested = scenes.flatMap((s) => {
      const caps = (s as Record<string, unknown>)?.captions;
      return Array.isArray(caps) ? caps : [];
    });
    const rawEntries = nested.length > 0 ? nested : Array.isArray(src.captions) ? src.captions : [];
    return rawEntries
      .map((c) => {
        const item = (c ?? {}) as Record<string, unknown>;
        return { time: Number(item.time) || 0, text: String(item.text ?? "").trim() };
      })
      .filter((e) => e.text.length > 0);
  }

  /** Ordered non-empty caption texts (fallback: scene subtitles). */
  static buildCaptionList(spec: Record<string, unknown> | null | undefined): string[] {
    const entries = ShortVideoService.buildCaptionEntries(spec);
    if (entries.length > 0) return entries.map((e) => e.text);

    const src = (spec ?? {}) as Record<string, unknown>;
    const scenes = Array.isArray(src.scenes) ? src.scenes : [];
    return scenes.map((s) => String((s as Record<string, unknown>)?.subtitle ?? "").trim()).filter(Boolean);
  }

  /**
   * One TTS text per scene: the scene's captions joined into a single sentence
   * so the voice engine reads the whole scene without unnatural pauses between
   * the word-by-word caption chunks. Falls back to `scene.subtitle`, then to a
   * legacy top-level `spec.captions` list (one text per entry).
   */
  static buildSceneVoiceTexts(
    spec: Record<string, unknown> | null | undefined,
  ): { sceneIndex: number; text: string }[] {
    const src = (spec ?? {}) as Record<string, unknown>;
    const scenes = Array.isArray(src.scenes) ? src.scenes : [];

    const out: { sceneIndex: number; text: string }[] = [];
    scenes.forEach((s, index) => {
      const scene = (s ?? {}) as Record<string, unknown>;
      const caps = Array.isArray(scene.captions) ? scene.captions : [];
      const joined = caps
        .map((c) => String((c as Record<string, unknown>)?.text ?? "").trim())
        .filter(Boolean)
        .join(" ")
        .trim();
      const text = joined || String(scene.subtitle ?? "").trim();
      if (text) out.push({ sceneIndex: index, text });
    });
    if (out.length > 0) return out;

    const top = Array.isArray(src.captions) ? src.captions : [];
    return top
      .map((c, index) => ({
        sceneIndex: index,
        text: String((c as Record<string, unknown>)?.text ?? "").trim(),
      }))
      .filter((e) => e.text.length > 0);
  }

  /** Join every caption text into a single sentence for TTS (fallback: scene subtitles). */
  static buildCaptionText(spec: Record<string, unknown> | null | undefined): string {
    return ShortVideoService.buildCaptionList(spec).join(" ");
  }

  mapForClient(row: ShortVideoHistory) {
    const playUrl = row.resultPath ? `/api/tools/shortvideo/artifact?shortVideoHistoryId=${row.id}` : null;
    return {
      id: row.id,
      userId: row.userId,
      nodeId: row.nodeId,
      displayName: row.displayName,
      status: row.status,
      spec: row.spec,
      engineConfig: row.engineConfig,
      resultPath: row.resultPath,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      queueJobId: row.queueJobId,
      renderStartedAt: row.renderStartedAt,
      renderFinishedAt: row.renderFinishedAt,
      renderDurationMs: row.renderDurationMs,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      playUrl,
      downloadUrl: playUrl,
    };
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
          "ShortVideo hoàn tất",
          `Video "${history.displayName}" đã sẵn sàng.`,
        );
      } catch (error) {
        this.logger.warn(`Failed to send ShortVideo success notification: ${String(error)}`);
      }
    }
  }

  async processFailed(id: string, errorMessage: string): Promise<void> {
    const timing = await this.resolveRenderTiming(id);
    await this.repository.update({ id }, { status: QueueJobStatus.FAILED, errorMessage, ...timing });
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

  async updateRuntimeMessage(id: string, message: string): Promise<void> {
    await this.repository.update({ id }, { errorMessage: message });
  }

  async persistSpec(id: string, spec: Record<string, unknown>): Promise<void> {
    await this.repository.update({ id }, { spec: spec as never });
  }

  prepareWorkDir(id: string): string {
    const workDir = join(this.resolveWorkRoot(), id);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "output"), { recursive: true });
    return workDir;
  }

  writeJobConfig(workDir: string, history: ShortVideoHistory): string {
    const configPath = join(workDir, "job_config.json");
    const cfg = {
      shortVideoHistoryId: history.id,
      nodeId: history.nodeId,
      displayName: history.displayName,
      spec: history.spec ?? {},
      engineConfig: history.engineConfig ?? {},
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    return configPath;
  }

  resolveArtifactPath(history: ShortVideoHistory): string {
    if (history.resultPath && existsSync(history.resultPath)) return history.resultPath;
    const fallback = join(this.resolveWorkRoot(), history.id, "output", "short_video.mp4");
    if (existsSync(fallback)) return fallback;
    throw new NotFoundException("ShortVideo output not found");
  }

  resolveScriptPath(): string {
    const raw = process.env.SHORTVIDEO_PYTHON_SCRIPT ?? "tools/video-pipeline/shortvideo/render.py";
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
}
