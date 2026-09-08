import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { Repository } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
import { resolveConfiguredPath } from "../../common/desktop/data-path";
import { AudioService } from "../audio/audio.service";
import { LogsService } from "../logs/logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { ModelsService } from "../models/models.service";
import { User } from "../users/user.entity";
import { CreateNarratoJobDto } from "./dto/create-narrato-job.dto";
import { NarratoHistory } from "./narrato-history.entity";
import {
  emptyNarratoStepProgress,
  readNarratoStepProgress,
  type NarratoStepId,
  type NarratoStepProgress,
} from "./narrato-steps.constants";
import { normalizeWorkDirSlug, slugFromVideoPath, toNarratoSnakeCaseSlug } from "./narrato-slug.util";

export const NARRATO_QUEUE_NAME = "video-narrato";

@Injectable()
export class NarratoService {
  private readonly logger = new Logger(NarratoService.name);

  constructor(
    @InjectQueue(NARRATO_QUEUE_NAME)
    private readonly narratoQueue: Queue,
    @InjectRepository(NarratoHistory, "tool")
    private readonly narratoRepository: Repository<NarratoHistory>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    private readonly logsService: LogsService,
    private readonly notificationsService: NotificationsService,
    private readonly audioService: AudioService,
    private readonly modelsService: ModelsService,
  ) {}

  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.NARRATO_QUEUE_LOCK_MS ?? process.env.RECAP_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const cmdTimeout = Number(process.env.NARRATO_CMD_TIMEOUT_MS ?? process.env.RECAP_CMD_TIMEOUT_MS ?? 3_600_000);
    return cmdTimeout + 180_000;
  }

  private resolveWorkRoot(): string {
    return resolveConfiguredPath(
      process.env.NARRATO_WORK_ROOT ?? process.env.RECAP_WORK_ROOT ?? process.env.TRANSLATE_WORK_ROOT,
      "uploads/narrato",
    );
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

  async enqueue(dto: CreateNarratoJobDto): Promise<NarratoHistory> {
    if (!dto.userId) throw new BadRequestException("userId is required");
    if (!dto.engineConfig?.localVideoPath) {
      throw new BadRequestException("engineConfig.localVideoPath is required");
    }

    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) throw new BadRequestException("User not found");

    const estimatedCost = dto.estimatedCost ?? 0;
    if (Number(user.credit) < estimatedCost) {
      throw new BadRequestException("Insufficient credit for narrato");
    }

    const videoPath = this.resolveVideoPath(dto.engineConfig.localVideoPath);
    const mode = String(dto.engineConfig.mode ?? "film_summary").trim() || "film_summary";
    const title =
      dto.displayName?.trim() ||
      dto.engineConfig.title?.trim() ||
      basename(videoPath).replace(/\.[^.]+$/, "") ||
      "Narrato";

    const workDirSlug =
      normalizeWorkDirSlug(String(dto.engineConfig.workDirSlug ?? "")) || slugFromVideoPath(videoPath);

    const ratePercent = dto.engineConfig.edgeTtsRatePercent ?? 0;
    const ttsEngine = String(dto.engineConfig.ttsEngine ?? "edge").trim().toLowerCase() || "edge";
    const engineConfig: Record<string, unknown> = {
      ...dto.engineConfig,
      localVideoPath: videoPath,
      workDirSlug,
      mode,
      subtitleSource: dto.engineConfig.subtitleSource ?? "whisper",
      whisperLanguage: dto.engineConfig.whisperLanguage ?? "vi",
      dramaGenre: dto.engineConfig.dramaGenre ?? "Drama / emotion",
      narrationLanguage: dto.engineConfig.narrationLanguage ?? "Vietnamese (Vietnam)",
      originalSoundRatio: dto.engineConfig.originalSoundRatio ?? 30,
      narrationWordCount: dto.engineConfig.narrationWordCount ?? 500,
      customClips: dto.engineConfig.customClips ?? 5,
      ttsEngine,
      edgeTtsVoice: dto.engineConfig.edgeTtsVoice ?? "vi-VN-HoaiMyNeural",
      edgeTtsRate:
        dto.engineConfig.edgeTtsRate ??
        `${ratePercent >= 0 ? "+" : ""}${ratePercent}%`,
      edgeTtsRatePercent: ratePercent,
      geminiModel: dto.engineConfig.geminiModel ?? process.env.NARRATO_GEMINI_MODEL ?? process.env.RECAP_GEMINI_MODEL ?? "",
      geminiKeyTier: dto.engineConfig.geminiKeyTier ?? "vip",
      narratoStepProgress: emptyNarratoStepProgress(),
    };

    if (ttsEngine === "omnivoice" || ttsEngine === "voxcpm2") {
      const refWav = String(engineConfig.omnivoiceRefWav ?? "").trim();
      const verified = await this.audioService.assertPipelineVoiceReady(
        refWav,
        String(engineConfig.omnivoiceRefText ?? "").trim() || undefined,
        dto.userId,
      );
      engineConfig.omnivoiceRefWav = verified.absolutePath.replace(/\\/g, "/");
      if (!String(engineConfig.omnivoiceRefText ?? "").trim() && verified.refText) {
        engineConfig.omnivoiceRefText = verified.refText;
      }
      if (!String(engineConfig.omnivoiceLanguage ?? "").trim()) {
        engineConfig.omnivoiceLanguage = verified.omnivoiceLanguage ?? "vietnamese";
      }
    }

    if (String(engineConfig.subtitleSource) === "upload") {
      const srtPath = String(engineConfig.srtPath ?? "").trim();
      if (!srtPath || !existsSync(isAbsolute(srtPath) ? srtPath : resolve(process.cwd(), srtPath))) {
        throw new BadRequestException("engineConfig.srtPath is required when subtitleSource=upload");
      }
    }

    const workDir = join(this.resolveWorkRoot(), workDirSlug);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "logs"), { recursive: true });

    const history = this.narratoRepository.create({
      userId: dto.userId,
      displayName: title,
      engineConfig,
      scriptPayload: this.readJsonIfExists(join(workDir, "script.json")),
      status: QueueJobStatus.COMPLETED,
      cost: estimatedCost.toFixed(2),
      queueJobId: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    const saved = await this.narratoRepository.save(history);
    this.writeJobConfig(workDir, saved);

    await this.logsService.createLog({
      userId: user.id,
      action: "narrato.created",
      payload: { narratoHistoryId: saved.id, displayName: saved.displayName, mode },
      ip: user.ip,
    });

    return saved;
  }

  async enqueueStep(narratoHistoryId: string, step: NarratoStepId): Promise<NarratoHistory> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) throw new NotFoundException("Narrato job not found");

    const progress = readNarratoStepProgress(history.engineConfig);
    if (progress.runningStep) {
      throw new BadRequestException(`Step ${progress.runningStep} is already running`);
    }
    if (history.status === QueueJobStatus.PENDING || history.status === QueueJobStatus.RUNNING) {
      throw new BadRequestException("Narrato job is busy");
    }

    const mode = String(history.engineConfig?.mode ?? "film_summary");
    if (step === "copy" && mode === "short") {
      throw new BadRequestException("copy is only for film_summary");
    }
    if (step === "match" && mode === "short") {
      throw new BadRequestException("match is only for film_summary");
    }
    if (step === "mix" && mode !== "short") {
      throw new BadRequestException("mix is only for short mix-cut");
    }

    if (step === "ingest" && String(history.engineConfig?.subtitleSource ?? "whisper") === "whisper") {
      this.modelsService.assertInstalled(["whisper-large-v3"]);
    }

    const nextProgress: NarratoStepProgress = {
      ...progress,
      runningStep: step,
      failedStep: null,
    };
    history.engineConfig = { ...(history.engineConfig ?? {}), narratoStepProgress: nextProgress };
    history.status = QueueJobStatus.PENDING;
    history.errorMessage = null;
    await this.narratoRepository.save(history);

    const queueJob = await this.narratoQueue.add(
      NARRATO_QUEUE_NAME,
      { narratoHistoryId, step },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );

    history.queueJobId = queueJob.id ? String(queueJob.id) : null;
    return this.narratoRepository.save(history);
  }

  async markStepStarted(narratoHistoryId: string, step: NarratoStepId): Promise<void> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) return;
    const progress = readNarratoStepProgress(history.engineConfig);
    history.engineConfig = {
      ...(history.engineConfig ?? {}),
      narratoStepProgress: { ...progress, runningStep: step, failedStep: null },
    };
    history.status = QueueJobStatus.RUNNING;
    history.errorMessage = `[STEP] ${step} — running`;
    await this.narratoRepository.save(history);
  }

  async markStepCompleted(
    narratoHistoryId: string,
    step: NarratoStepId,
    extras?: {
      resultPath?: string;
      scriptPayload?: Record<string, unknown> | null;
      plotText?: string | null;
      copyText?: string | null;
    },
  ): Promise<void> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) return;

    const progress = readNarratoStepProgress(history.engineConfig);
    const completedSteps = progress.completedSteps.includes(step)
      ? progress.completedSteps
      : [...progress.completedSteps, step];

    history.engineConfig = {
      ...(history.engineConfig ?? {}),
      narratoStepProgress: {
        completedSteps,
        runningStep: null,
        failedStep: null,
      },
      ...(extras?.plotText != null ? { plotAnalysis: extras.plotText } : {}),
      ...(extras?.copyText != null ? { narrationCopy: extras.copyText } : {}),
    };
    history.status = QueueJobStatus.COMPLETED;
    history.errorMessage = null;
    history.queueJobId = null;
    if (extras?.scriptPayload) history.scriptPayload = extras.scriptPayload;
    if (extras?.resultPath) {
      history.resultPath = extras.resultPath;
      history.resultFileName = basename(extras.resultPath);
    }
    await this.narratoRepository.save(history);

    if (step === "render" && extras?.resultPath && history.userId) {
      await this.notificationsService.pushSuccess(
        history.userId,
        "Narrato hoàn tất",
        `Video đã sẵn sàng${history.resultFileName ? `: ${history.resultFileName}` : ""}.`,
      );
    }
  }

  async markStepFailed(narratoHistoryId: string, step: NarratoStepId, errorMessage: string): Promise<void> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) return;
    const progress = readNarratoStepProgress(history.engineConfig);
    history.engineConfig = {
      ...(history.engineConfig ?? {}),
      narratoStepProgress: { ...progress, runningStep: null, failedStep: step },
    };
    history.status = QueueJobStatus.FAILED;
    history.errorMessage = errorMessage;
    history.queueJobId = null;
    await this.narratoRepository.save(history);
    if (history.userId) {
      await this.notificationsService.pushError(
        history.userId,
        "Narrato step lỗi",
        errorMessage,
        `Step ${step} thất bại.`,
      );
    }
  }

  async getById(id: string): Promise<NarratoHistory | null> {
    return this.narratoRepository.findOne({ where: { id } });
  }

  async getHistory(userId: string): Promise<NarratoHistory[]> {
    return this.narratoRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
      take: 50,
    });
  }

  mapHistoryForClient(row: NarratoHistory) {
    const playUrl = row.resultPath
      ? `/api/tools/narrato/artifact?narratoHistoryId=${row.id}&type=video`
      : null;
    const workDir = this.resolveWorkDir(row);
    return {
      id: row.id,
      userId: row.userId,
      displayName: row.displayName,
      status: row.status,
      cost: row.cost,
      resultPath: row.resultPath,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      scriptPayload: row.scriptPayload,
      engineConfig: row.engineConfig,
      queueJobId: row.queueJobId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      playUrl,
      downloadUrl: playUrl,
      workDirSlug: this.resolveWorkDirSlug(row),
      stepProgress: readNarratoStepProgress(row.engineConfig),
      plotAnalysis: this.readTextIfExists(join(workDir, "plot.md")) ?? row.engineConfig?.plotAnalysis ?? "",
      narrationCopy:
        this.readTextIfExists(join(workDir, "narration_copy.txt")) ?? row.engineConfig?.narrationCopy ?? "",
    };
  }

  async updateRuntimeMessage(narratoHistoryId: string, message: string): Promise<void> {
    await this.narratoRepository.update({ id: narratoHistoryId }, { errorMessage: message });
  }

  async updateScriptPayload(
    narratoHistoryId: string,
    scriptPayload: Record<string, unknown>,
  ): Promise<NarratoHistory> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) throw new NotFoundException("Narrato job not found");
    history.scriptPayload = scriptPayload;
    const saved = await this.narratoRepository.save(history);
    this.syncScriptToWorkDir(saved);
    return saved;
  }

  async updatePlot(narratoHistoryId: string, text: string): Promise<NarratoHistory> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) throw new NotFoundException("Narrato job not found");
    const workDir = this.prepareWorkDir(history);
    writeFileSync(join(workDir, "plot.md"), text ?? "", "utf-8");
    history.engineConfig = { ...(history.engineConfig ?? {}), plotAnalysis: text };
    return this.narratoRepository.save(history);
  }

  async updateCopy(narratoHistoryId: string, text: string): Promise<NarratoHistory> {
    const history = await this.narratoRepository.findOne({ where: { id: narratoHistoryId } });
    if (!history) throw new NotFoundException("Narrato job not found");
    const workDir = this.prepareWorkDir(history);
    writeFileSync(join(workDir, "narration_copy.txt"), text ?? "", "utf-8");
    history.engineConfig = { ...(history.engineConfig ?? {}), narrationCopy: text };
    return this.narratoRepository.save(history);
  }

  syncScriptToWorkDir(history: NarratoHistory): boolean {
    const payload = history.scriptPayload;
    const items = payload?.items;
    if (!Array.isArray(items) || items.length === 0) return false;
    const workDir = this.resolveWorkDir(history);
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(workDir, "script.json"), JSON.stringify({ items }, null, 2), "utf-8");
    return true;
  }

  resolveWorkDirSlug(history: NarratoHistory): string {
    const fromConfig = normalizeWorkDirSlug(String(history.engineConfig?.workDirSlug ?? ""));
    if (fromConfig) return fromConfig;
    const videoPath = String(history.engineConfig?.localVideoPath ?? "").trim();
    if (videoPath) {
      const fromVideo = slugFromVideoPath(videoPath);
      if (fromVideo) return fromVideo;
    }
    const fromTitle = toNarratoSnakeCaseSlug(history.displayName || "");
    if (fromTitle !== "narrato") return fromTitle;
    return history.id;
  }

  resolveWorkDir(history: NarratoHistory): string {
    return join(this.resolveWorkRoot(), this.resolveWorkDirSlug(history));
  }

  prepareWorkDir(history: NarratoHistory): string {
    const workDir = this.resolveWorkDir(history);
    mkdirSync(workDir, { recursive: true });
    mkdirSync(join(workDir, "logs"), { recursive: true });
    return workDir;
  }

  writeJobConfig(workDir: string, history: NarratoHistory): string {
    const configPath = join(workDir, "job_config.json");
    const cfg = {
      narratoHistoryId: history.id,
      displayName: history.displayName,
      ...(history.engineConfig ?? {}),
    };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf-8");
    return configPath;
  }

  readJsonIfExists(filePath: string): Record<string, unknown> | null {
    if (!existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
      return null;
    } catch (error) {
      this.logger.warn(`Failed to parse JSON ${filePath}: ${error}`);
      return null;
    }
  }

  readTextIfExists(filePath: string): string | null {
    if (!existsSync(filePath)) return null;
    try {
      return readFileSync(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  getRuntimeLog(history: NarratoHistory): string {
    const logPath = join(this.resolveWorkDir(history), "logs", "pipeline.log");
    if (existsSync(logPath)) return readFileSync(logPath, "utf-8");
    return "";
  }

  resolveArtifactPath(history: NarratoHistory, type: "video" | "script" | "plot" | "copy"): string {
    if (type === "video" && history.resultPath && existsSync(history.resultPath)) {
      return history.resultPath;
    }
    const workDir = this.resolveWorkDir(history);
    if (type === "script") {
      const p = join(workDir, "script.json");
      if (existsSync(p)) return p;
      throw new NotFoundException("script.json not found");
    }
    if (type === "plot") {
      const p = join(workDir, "plot.md");
      if (existsSync(p)) return p;
      throw new NotFoundException("plot.md not found");
    }
    if (type === "copy") {
      const p = join(workDir, "narration_copy.txt");
      if (existsSync(p)) return p;
      throw new NotFoundException("narration_copy.txt not found");
    }
    const fallback = join(workDir, "output", "narrato.mp4");
    if (existsSync(fallback)) return fallback;
    throw new NotFoundException("Narrato video not found");
  }

  ensureArtifactDir(filePath: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
  }
}
