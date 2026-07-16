import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { CreditHistory } from "../credits/credit-history.entity";
import { LogsService } from "../logs/logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/user.entity";
import { CreateRecapJobDto } from "./dto/create-recap-job.dto";
import { RecapHistory } from "./recap-history.entity";

export const RECAP_QUEUE_NAME = "video-recap";

@Injectable()
export class RecapService {
  private readonly logger = new Logger(RecapService.name);

  constructor(
    @InjectQueue(RECAP_QUEUE_NAME)
    private readonly recapQueue: Queue,
    @InjectRepository(RecapHistory, "tool")
    private readonly recapRepository: Repository<RecapHistory>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditHistory, "tool")
    private readonly creditHistoryRepository: Repository<CreditHistory>,
    private readonly logsService: LogsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.RECAP_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cmdTimeout = Number(process.env.RECAP_CMD_TIMEOUT_MS ?? 3_600_000);
    return cmdTimeout + 180_000;
  }

  private resolveWorkRoot(): string {
    return resolve(process.cwd(), process.env.RECAP_WORK_ROOT ?? process.env.TRANSLATE_WORK_ROOT ?? "uploads/recap");
  }

  resolveVideoPath(localVideoPath: string): string {
    const raw = String(localVideoPath || "").trim();
    if (!raw) throw new BadRequestException("engineConfig.localVideoPath is required");
    const abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
    if (!existsSync(abs)) {
      throw new BadRequestException(`Video not found: ${raw}`);
    }
    return abs;
  }

  async enqueue(dto: CreateRecapJobDto): Promise<RecapHistory> {
    if (!dto.userId) throw new BadRequestException("userId is required");
    if (!dto.engineConfig?.localVideoPath) {
      throw new BadRequestException("engineConfig.localVideoPath is required");
    }

    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) throw new BadRequestException("User not found");

    const estimatedCost = dto.estimatedCost ?? 0;
    if (Number(user.credit) < estimatedCost) {
      throw new BadRequestException("Insufficient credit for recap");
    }

    const videoPath = this.resolveVideoPath(dto.engineConfig.localVideoPath);
    const title =
      dto.displayName?.trim() ||
      dto.engineConfig.title?.trim() ||
      basename(videoPath).replace(/\.[^.]+$/, "") ||
      "Movie Recap";

    const engineConfig: Record<string, unknown> = {
      ...dto.engineConfig,
      localVideoPath: videoPath,
      durationMinSec: dto.engineConfig.durationMinSec ?? 900,
      durationMaxSec: dto.engineConfig.durationMaxSec ?? 1200,
      wordsPerMinute: dto.engineConfig.wordsPerMinute ?? 140,
      locale: dto.engineConfig.locale ?? "vi",
      ttsEngine: dto.engineConfig.ttsEngine ?? "omnivoice",
      edgeTtsVoice: dto.engineConfig.edgeTtsVoice ?? "vi-VN-HoaiMyNeural",
      edgeTtsRate:
        dto.engineConfig.edgeTtsRate ??
        (dto.engineConfig.edgeTtsRatePercent != null
          ? `${dto.engineConfig.edgeTtsRatePercent >= 0 ? "+" : ""}${dto.engineConfig.edgeTtsRatePercent}%`
          : "+0%"),
      edgeTtsRatePercent: dto.engineConfig.edgeTtsRatePercent ?? 0,
      videoSpeed: dto.engineConfig.videoSpeed ?? 1,
      keepDebugArtifacts: dto.engineConfig.keepDebugArtifacts ?? true,
    };

    const history = this.recapRepository.create({
      userId: dto.userId,
      displayName: title,
      movieId: dto.movieId ?? null,
      engineConfig,
      scriptPayload: null,
      timelinePayload: null,
      status: QueueJobStatus.PENDING,
      cost: estimatedCost.toFixed(2),
      queueJobId: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    const created = await this.recapRepository.save(history);

    const queueJob = await this.recapQueue.add(
      RECAP_QUEUE_NAME,
      { recapHistoryId: created.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );

    created.queueJobId = queueJob.id ? String(queueJob.id) : null;
    const saved = await this.recapRepository.save(created);

    await this.logsService.createLog({
      userId: user.id,
      action: "recap.queued",
      payload: {
        recapHistoryId: saved.id,
        queueJobId: saved.queueJobId,
        movieId: saved.movieId,
        displayName: saved.displayName,
      },
      ip: user.ip,
    });

    return saved;
  }

  async getById(id: string): Promise<RecapHistory | null> {
    return this.recapRepository.findOne({ where: { id } });
  }

  async getHistory(userId: string): Promise<RecapHistory[]> {
    return this.recapRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  mapHistoryForClient(row: RecapHistory) {
    const playUrl = row.resultPath
      ? `/api/tools/recap/artifact?recapHistoryId=${row.id}&type=video`
      : null;
    return {
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      movieId: row.movieId,
      status: row.status,
      cost: row.cost,
      resultPath: row.resultPath,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      scriptPayload: row.scriptPayload,
      timelinePayload: row.timelinePayload,
      engineConfig: row.engineConfig,
      queueJobId: row.queueJobId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      playUrl,
      downloadUrl: playUrl,
    };
  }

  async processStarted(recapHistoryId: string): Promise<void> {
    await this.recapRepository.update(
      { id: recapHistoryId },
      { status: QueueJobStatus.RUNNING, errorMessage: null },
    );
  }

  async processCompleted(
    recapHistoryId: string,
    resultPath: string,
    extras?: {
      scriptPayload?: Record<string, unknown> | null;
      timelinePayload?: Record<string, unknown> | null;
    },
  ): Promise<void> {
    const history = await this.recapRepository.findOne({ where: { id: recapHistoryId } });
    if (!history) return;

    history.status = QueueJobStatus.COMPLETED;
    history.resultPath = resultPath;
    history.resultFileName = basename(resultPath);
    history.errorMessage = null;
    if (extras?.scriptPayload) history.scriptPayload = extras.scriptPayload;
    if (extras?.timelinePayload) history.timelinePayload = extras.timelinePayload;
    await this.recapRepository.save(history);

    const user = await this.userRepository.findOne({ where: { id: history.userId } });
    if (user) {
      const next = Math.max(Number(user.credit) - Number(history.cost), 0);
      user.credit = next.toFixed(2);
      await this.userRepository.save(user);

      await this.creditHistoryRepository.save(
        this.creditHistoryRepository.create({
          userId: user.id,
          amount: (-Number(history.cost)).toFixed(2),
          balance: user.credit,
          reason: "recap_movie",
          metadata: { recapHistoryId: history.id },
        }),
      );

      await this.notificationsService.pushSuccess(
        user.id,
        "Recap hoàn tất",
        `Video recap đã sẵn sàng${history.resultFileName ? `: ${history.resultFileName}` : ""}.`,
      );
    }
  }

  async processFailed(recapHistoryId: string, errorMessage: string): Promise<void> {
    const history = await this.recapRepository.findOne({ where: { id: recapHistoryId } });
    await this.recapRepository.update(
      { id: recapHistoryId },
      { status: QueueJobStatus.FAILED, errorMessage },
    );
    if (history?.userId) {
      await this.notificationsService.pushError(
        history.userId,
        "Recap xử lý lỗi",
        errorMessage,
        "Không tạo được recap. Kiểm tra file nguồn / cấu hình và thử lại.",
      );
    }
  }

  async updateRuntimeMessage(recapHistoryId: string, message: string): Promise<void> {
    await this.recapRepository.update({ id: recapHistoryId }, { errorMessage: message });
  }

  async updateScriptPayload(
    recapHistoryId: string,
    scriptPayload: Record<string, unknown>,
  ): Promise<RecapHistory> {
    const history = await this.recapRepository.findOne({ where: { id: recapHistoryId } });
    if (!history) throw new NotFoundException("Recap job not found");
    history.scriptPayload = scriptPayload;
    return this.recapRepository.save(history);
  }

  prepareWorkDir(recapHistoryId: string): string {
    const workDir = join(this.resolveWorkRoot(), recapHistoryId);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "logs"), { recursive: true });
    return workDir;
  }

  writeJobConfig(workDir: string, history: RecapHistory): string {
    const configPath = join(workDir, "job_config.json");
    const cfg = {
      recapHistoryId: history.id,
      displayName: history.displayName,
      movieId: history.movieId,
      ...(history.engineConfig ?? {}),
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    return configPath;
  }

  readJsonIfExists(filePath: string): Record<string, unknown> | null {
    if (!existsSync(filePath)) return null;
    try {
      return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    } catch (error) {
      this.logger.warn(`Failed to parse JSON ${filePath}: ${error}`);
      return null;
    }
  }

  getRuntimeLog(recapHistoryId: string): string {
    const logPath = join(this.resolveWorkRoot(), recapHistoryId, "logs", "pipeline.log");
    if (!existsSync(logPath)) return "";
    return readFileSync(logPath, "utf-8");
  }

  resolveArtifactPath(history: RecapHistory, type: "video" | "script" | "timeline"): string {
    const workDir = join(this.resolveWorkRoot(), history.id);
    if (type === "script") {
      const p = join(workDir, "script.json");
      if (!existsSync(p)) throw new NotFoundException("script.json not found");
      return p;
    }
    if (type === "timeline") {
      const p = join(workDir, "timeline.json");
      if (!existsSync(p)) throw new NotFoundException("timeline.json not found");
      return p;
    }
    if (history.resultPath && existsSync(history.resultPath)) return history.resultPath;
    const fallback = join(workDir, "output", "recap.mp4");
    if (existsSync(fallback)) return fallback;
    throw new NotFoundException("Recap video not found");
  }

  ensureArtifactDir(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }
}
