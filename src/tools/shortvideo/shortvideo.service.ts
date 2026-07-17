import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { CreateShortVideoJobDto } from "./dto/create-shortvideo-job.dto";
import { RenderShortVideoUploadDto } from "./dto/render-shortvideo-upload.dto";
import { ShortVideoHistory } from "./shortvideo-history.entity";

const UPLOAD_FIELDS = ["background", "left", "right", "voice"] as const;
type UploadField = (typeof UPLOAD_FIELDS)[number];
type UploadedFiles = Partial<Record<UploadField, Express.Multer.File[]>>;

const DEFAULT_EXT: Record<UploadField, string> = {
  background: ".png",
  left: ".png",
  right: ".png",
  voice: ".mp3",
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
  async enqueueFromUpload(
    body: RenderShortVideoUploadDto,
    files: UploadedFiles,
  ): Promise<ShortVideoHistory> {
    const spec = this.parseSpec(body.spec);
    const { assetsDir, fileNames } = this.saveUploadAssets(files);

    if (fileNames.background) spec.background = fileNames.background;
    if (fileNames.voice) spec.voice = fileNames.voice;
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

  mapForClient(row: ShortVideoHistory) {
    const playUrl = row.resultPath
      ? `/api/tools/shortvideo/artifact?shortVideoHistoryId=${row.id}`
      : null;
    return {
      id: row.id,
      userId: row.userId,
      nodeId: row.nodeId,
      displayName: row.displayName,
      status: row.status,
      resultPath: row.resultPath,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      queueJobId: row.queueJobId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      playUrl,
      downloadUrl: playUrl,
    };
  }

  async processStarted(id: string): Promise<void> {
    await this.repository.update({ id }, { status: QueueJobStatus.RUNNING, errorMessage: null });
  }

  async processCompleted(id: string, resultPath: string): Promise<void> {
    await this.repository.update(
      { id },
      {
        status: QueueJobStatus.COMPLETED,
        resultPath,
        resultFileName: basename(resultPath),
        errorMessage: null,
      },
    );
  }

  async processFailed(id: string, errorMessage: string): Promise<void> {
    await this.repository.update({ id }, { status: QueueJobStatus.FAILED, errorMessage });
  }

  async updateRuntimeMessage(id: string, message: string): Promise<void> {
    await this.repository.update({ id }, { errorMessage: message });
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
    const raw =
      process.env.SHORTVIDEO_PYTHON_SCRIPT ?? "tools/video-pipeline/shortvideo/render.py";
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }
}
