import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { Queue } from "bullmq";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "path";
import { Repository } from "typeorm";

import { CreditHistory } from "../credits/credit-history.entity";
import { resolveOmnivoiceLanguageValue } from "../audio/audio.constants";
import { AudioService } from "../audio/audio.service";
import { LogsService } from "../logs/logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/user.entity";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import { resolveTranslateWorkRoot } from "../../common/desktop/data-path";
import {
  CANCELLED_BY_USER_MESSAGE,
  type CancelRenderResult,
  discardQueueJob,
  RenderJobKeys,
  shouldDeleteRenderFiles,
} from "../../common/process/render-cancel";
import { RenderProcessRegistry } from "../../common/process/render-process-registry";
import { isAppPlatform } from "../../common/desktop/request-platform";
import { ModelsService } from "../models/models.service";
import { CreateTranslateJobDto } from "./dto/create-translate-job.dto";
import { TranslateEngineConfigDto } from "./dto/translate-engine-config.dto";
import { TranslateHistory } from "./translate-history.entity";

export const TRANSLATE_QUEUE_NAME = "video-translate";
export type TranslateArtifactType = "zh" | "vi" | "audio" | "video";
const STEP_TO_FUNCTION_CODE: Record<number, string> = {
  1: "GET_SUBTITLES_ORIGINAL",
  2: "TRANSLATE_BY_AI",
  3: "GENERATE_VOICE_TTS",
  4: "MERGE_VIDEO_WITH_VOICE_TTS",
  5: "CREATE_SUBTITLE_TO_ASS",
  6: "MERGE_VIDEO_WITH_SUBTITLE_AND_LOGO",
};

@Injectable()
export class TranslateService {
  constructor(
    @InjectQueue(TRANSLATE_QUEUE_NAME)
    private readonly translateQueue: Queue,
    @InjectRepository(TranslateHistory, "tool")
    private readonly translateRepository: Repository<TranslateHistory>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditHistory, "tool")
    private readonly creditHistoryRepository: Repository<CreditHistory>,
    private readonly logsService: LogsService,
    private readonly notificationsService: NotificationsService,
    private readonly audioService: AudioService,
    private readonly modelsService: ModelsService,
    private readonly renderProcessRegistry: RenderProcessRegistry,
  ) {}

  async enqueue(dto: CreateTranslateJobDto): Promise<TranslateHistory> {
    if (!dto.userId) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    const estimatedCost = dto.estimatedCost ?? 1;
    const availableCredit = Number(user.credit);
    if (availableCredit < estimatedCost) {
      throw new BadRequestException("Insufficient credit for translation");
    }

    const normalizedSteps = this.normalizeSteps(dto.stepNbr);
    const functionUsed = normalizedSteps.map((step) => STEP_TO_FUNCTION_CODE[step]);

    await this.validateOmnivoiceConfigForTranslate(normalizedSteps, dto.engineConfig, dto.userId);
    if (isAppPlatform()) {
      this.modelsService.assertInstalled(
        this.modelsService.requiredModelsForTranslate(dto.engineConfig as Record<string, unknown>, normalizedSteps),
      );
    }

    const engineConfig = dto.engineConfig ? ({ ...dto.engineConfig } as Record<string, unknown>) : null;
    const reusable = engineConfig
      ? await this.findReusableHistory(dto.userId, engineConfig)
      : null;
    if (reusable && (reusable.status === QueueJobStatus.PENDING || reusable.status === QueueJobStatus.RUNNING)) {
      throw new ConflictException("Video này đang được render. Hủy job cũ trước khi render lại.");
    }

    if (reusable?.queueJobId) {
      await discardQueueJob(this.translateQueue, reusable.queueJobId);
    }

    const history = reusable
      ? this.translateRepository.merge(reusable, {
          stepNbr: normalizedSteps,
          functionUsed,
          engineConfig: engineConfig as any,
          status: QueueJobStatus.PENDING,
          cost: estimatedCost.toFixed(2),
          queueJobId: null,
          resultPath: null,
          resultFileName: null,
          errorMessage: null,
        })
      : this.translateRepository.create({
          userId: dto.userId,
          stepNbr: normalizedSteps,
          functionUsed,
          engineConfig: engineConfig as any,
          status: QueueJobStatus.PENDING,
          cost: estimatedCost.toFixed(2),
          queueJobId: null,
          resultPath: null,
          resultFileName: null,
          errorMessage: null,
        });
    const created = await this.translateRepository.save(history);

    this.renderProcessRegistry.begin(RenderJobKeys.translate(created.id));
    const queueJob = await this.translateQueue.add(
      TRANSLATE_QUEUE_NAME,
      { translateHistoryId: created.id },
      { attempts: 2, removeOnComplete: true, removeOnFail: 50 },
    );

    created.queueJobId = queueJob.id ? String(queueJob.id) : null;
    const saved = await this.translateRepository.save(created);

    await this.logsService.createLog({
      userId: user.id,
      action: "translate.queued",
      payload: {
        translateHistoryId: saved.id,
        queueJobId: saved.queueJobId,
        stepNbr: saved.stepNbr,
        functionUsed: saved.functionUsed,
      },
      ip: user.ip,
    });
    void this.logsService.logRender({
      userId: user.id,
      feature: "translate",
      historyId: saved.id,
      displayName: String((saved.engineConfig as Record<string, unknown> | null)?.localVideoPath ?? "translate"),
      data: {
        stepNbr: saved.stepNbr,
        functionUsed: saved.functionUsed,
        cost: saved.cost,
        engineConfig: saved.engineConfig,
      },
    });
    return saved;
  }

  async processStarted(translateHistoryId: string): Promise<void> {
    await this.translateRepository.update(
      { id: translateHistoryId },
      { status: QueueJobStatus.RUNNING, errorMessage: null },
    );
  }

  async processCompleted(translateHistoryId: string, resultPath: string): Promise<void> {
    const history = await this.translateRepository.findOne({
      where: { id: translateHistoryId },
    });
    if (!history) {
      return;
    }

    history.status = QueueJobStatus.COMPLETED;
    history.resultPath = resultPath;
    history.resultFileName = basename(resultPath);
    history.errorMessage = null;
    await this.translateRepository.save(history);

    const user = await this.userRepository.findOne({ where: { id: history.userId } });
    if (user) {
      const current = Number(user.credit);
      const next = Math.max(current - Number(history.cost), 0);
      user.credit = next.toFixed(2);
      await this.userRepository.save(user);

      await this.creditHistoryRepository.save(
        this.creditHistoryRepository.create({
          userId: user.id,
          amount: (-Number(history.cost)).toFixed(2),
          balance: user.credit,
          reason: "translate_video",
          metadata: { translateHistoryId: history.id },
        }),
      );

      await this.notificationsService.pushSuccess(
        user.id,
        "Video hoàn tất",
        `Video đã xử lý xong${history.resultFileName ? `: ${history.resultFileName}` : ""}.`,
      );
    }
  }

  async processFailed(translateHistoryId: string, errorMessage: string): Promise<void> {
    const history = await this.translateRepository.findOne({ where: { id: translateHistoryId } });
    if (!history || history.status === QueueJobStatus.CANCELLED) return;
    await this.translateRepository.update(
      { id: translateHistoryId },
      {
        status: QueueJobStatus.FAILED,
        errorMessage,
      },
    );
    if (history?.userId) {
      await this.notificationsService.pushError(
        history.userId,
        "Video xử lý lỗi",
        errorMessage,
        "Video không xử lý được. Kiểm tra lại file nguồn / cấu hình và thử lại.",
      );
    }
  }

  async processRuntimeStatus(
    translateHistoryId: string,
    input: { step: number; state: "running" | "completed" | "failed"; message?: string },
  ): Promise<void> {
    const step = Number(input.step);
    const state = String(input.state || "").trim().toLowerCase();
    const message = String(input.message || "").trim();
    const composed = `[Step ${step}] ${state}${message ? `: ${message}` : ""}`;
    await this.translateRepository.update(
      { id: translateHistoryId },
      {
        status: state === "failed" ? QueueJobStatus.FAILED : QueueJobStatus.RUNNING,
        errorMessage: composed,
      },
    );
  }

  async getHistory(userId: string): Promise<TranslateHistory[]> {
    return this.translateRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async getById(id: string): Promise<TranslateHistory | null> {
    return this.translateRepository.findOne({ where: { id } });
  }

  async cancel(id: string, userId: string): Promise<CancelRenderResult> {
    const history = await this.translateRepository.findOne({ where: { id } });
    if (!history) throw new NotFoundException("Translate job not found");
    if (history.userId !== userId) throw new NotFoundException("Translate job not found");
    if (history.status !== QueueJobStatus.PENDING && history.status !== QueueJobStatus.RUNNING) {
      throw new ConflictException("Translate job is not running");
    }

    const key = RenderJobKeys.translate(id);
    this.renderProcessRegistry.requestCancel(key);
    await discardQueueJob(this.translateQueue, history.queueJobId);

    const deletedFiles = shouldDeleteRenderFiles();
    if (deletedFiles) {
      this.cleanupCancelledWorkspace(history);
    }
    await this.markCancelled(id, deletedFiles);
    return { status: "cancelled", cancelled: true, deletedFiles };
  }

  async markCancelled(translateHistoryId: string, deletedFiles = shouldDeleteRenderFiles()): Promise<void> {
    await this.translateRepository.update(
      { id: translateHistoryId },
      {
        status: QueueJobStatus.CANCELLED,
        errorMessage: CANCELLED_BY_USER_MESSAGE,
        queueJobId: null,
        ...(deletedFiles ? { resultPath: null, resultFileName: null } : {}),
      },
    );
  }

  private cleanupCancelledWorkspace(history: TranslateHistory): void {
    const workspaceDir = this.resolveJobWorkspaceDir(history);
    if (!workspaceDir) return;
    try {
      if (existsSync(workspaceDir)) {
        rmSync(workspaceDir, { recursive: true, force: true });
      }
    } catch {
      const logPath = this.tryRuntimeLogPath(history);
      if (logPath) {
        try {
          writeFileSync(logPath, "[CANCELLED]\n", "utf-8");
        } catch {
          /* ignore */
        }
      }
    }
  }

  private resolveJobWorkspaceDir(history: TranslateHistory): string | null {
    try {
      if (history.resultPath) {
        return this.resolveWorkspaceDir(this.normalizeResultPath(history.resultPath));
      }
    } catch {
      /* fall through to engineConfig */
    }
    const engineConfig = history.engineConfig ?? {};
    const localPath = this.pickConfigValue(engineConfig, ["localVideoPath", "local_video_path"]);
    if (typeof localPath !== "string" || !localPath.trim()) return null;
    const workName = basename(resolve(localPath.trim()), extname(resolve(localPath.trim())));
    if (!workName) return null;
    return join(this.translateWorkRoot(), workName);
  }

  private tryRuntimeLogPath(history: TranslateHistory): string | null {
    try {
      return this.resolveRuntimeLogPath(history);
    } catch {
      return null;
    }
  }

  parseArtifactType(type?: string): TranslateArtifactType {
    if (type === "zh" || type === "vi" || type === "audio" || type === "video") {
      return type;
    }
    throw new BadRequestException("type must be one of: zh, vi, audio, video");
  }

  resolveArtifact(resultPath: string, type: TranslateArtifactType): { absolutePath: string; contentType: string } {
    const normalizedResultPath = this.normalizeResultPath(resultPath);
    const workspaceDir = this.resolveWorkspaceDir(normalizedResultPath);
    const workName = basename(workspaceDir);

    let absolutePath = normalizedResultPath;
    let contentType = "video/mp4";

    if (type === "zh" || type === "vi") {
      const preferredSubtitlePath = join(workspaceDir, "subtitles", `${workName}.${type}.srt`);
      const legacySubtitlePath = join(workspaceDir, "subtitles", `${type}.srt`);
      absolutePath = existsSync(preferredSubtitlePath) ? preferredSubtitlePath : legacySubtitlePath;
      contentType = "text/plain; charset=utf-8";
    } else if (type === "audio") {
      absolutePath = join(workspaceDir, "videos", `${workName}_voice.wav`);
      contentType = "audio/wav";
    } else if (extname(normalizedResultPath).toLowerCase() !== ".mp4") {
      absolutePath = join(workspaceDir, "videos", `${workName}_vs_tm.mp4`);
    }

    if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
      throw new NotFoundException(`Artifact not found for type ${type}`);
    }

    return { absolutePath, contentType };
  }

  resolvePlayableVideoPath(history: TranslateHistory): string | null {
    const candidates: string[] = [];
    const raw = history.resultPath?.trim() ?? "";
    if (raw) {
      try {
        candidates.push(this.resolveArtifact(raw, "video").absolutePath);
      } catch {
        /* try fallbacks below */
      }
      candidates.push(raw);
    }
    const workDir = this.resolveJobWorkspaceDir(history);
    if (workDir) {
      const workName = basename(workDir);
      candidates.push(
        join(workDir, "videos", `${workName}_vs_tm.mp4`),
        join(workDir, "videos", `${workName}_vs_tm_outro.mp4`),
        join(workDir, `${workName}_vs_tm.mp4`),
      );
    }
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const resolved = candidate.trim();
      if (!resolved || seen.has(resolved)) continue;
      seen.add(resolved);
      if (existsSync(resolved) && statSync(resolved).isFile() && extname(resolved).toLowerCase() === ".mp4") {
        return resolved;
      }
    }
    return null;
  }

  private resolveWorkNameFromFile(fileName: string): string {
    const base = basename(String(fileName ?? "").trim());
    const workName = basename(base, extname(base)).trim();
    if (!workName || workName === "." || workName === ".." || /[\\/]/.test(workName)) {
      throw new BadRequestException("fileName is invalid");
    }
    return workName;
  }

  private resolveWorkspaceLocation(fileName: string): { workName: string; workDir: string; exists: boolean } {
    const workName = this.resolveWorkNameFromFile(fileName);
    const workDir = join(this.translateWorkRoot(), workName);
    const exists = existsSync(workDir) && statSync(workDir).isDirectory();
    return { workName, workDir, exists };
  }

  statWorkspaceByFileName(fileName: string): { workName: string; workDir: string; exists: boolean } {
    return this.resolveWorkspaceLocation(fileName);
  }

  loadWorkspaceByFileName(fileName: string): {
    workName: string;
    workDir: string;
    exists: boolean;
    zhSrt: string;
    viSrt: string;
    voiceIndices: number[];
  } {
    const { workName, workDir, exists } = this.resolveWorkspaceLocation(fileName);
    if (!exists) {
      throw new NotFoundException(`Không tìm thấy folder render cho file ${workName}`);
    }

    const readSrt = (type: "zh" | "vi"): string => {
      const preferred = join(workDir, "subtitles", `${workName}.${type}.srt`);
      const legacy = join(workDir, "subtitles", `${type}.srt`);
      const path = existsSync(preferred) ? preferred : existsSync(legacy) ? legacy : null;
      if (!path) return "";
      return readFileSync(path, "utf8");
    };

    const voiceIndices = new Set<number>();
    const chunkDir = join(workDir, "logs", "tts_chunks");
    if (existsSync(chunkDir) && statSync(chunkDir).isDirectory()) {
      for (const name of readdirSync(chunkDir)) {
        const match = /^(?:part|empty)_(\d{4})\.wav$/i.exec(name);
        if (!match) continue;
        voiceIndices.add(Number(match[1]));
      }
    }

    return {
      workName,
      workDir,
      exists: true,
      zhSrt: readSrt("zh"),
      viSrt: readSrt("vi"),
      voiceIndices: [...voiceIndices].sort((a, b) => a - b),
    };
  }

  resolveCueVoice(fileName: string, index: number): { absolutePath: string; contentType: string } {
    const workName = this.resolveWorkNameFromFile(fileName);
    const workDir = join(this.translateWorkRoot(), workName);
    if (!this.isInsideRoot(this.translateWorkRoot(), workDir)) {
      throw new BadRequestException("Invalid work folder");
    }
    const padded = String(Math.max(0, Math.floor(index))).padStart(4, "0");
    const chunkDir = join(workDir, "logs", "tts_chunks");
    const partPath = join(chunkDir, `part_${padded}.wav`);
    const emptyPath = join(chunkDir, `empty_${padded}.wav`);
    const absolutePath = existsSync(partPath) ? partPath : emptyPath;
    if (!existsSync(absolutePath)) {
      throw new NotFoundException("Chưa có file voice cho dòng này");
    }
    return { absolutePath, contentType: "audio/wav" };
  }

  private normalizeSteps(stepNbr: number[]): number[] {
    const normalized = [...new Set(stepNbr)].sort((a, b) => a - b);
    if (normalized.length === 0) {
      throw new BadRequestException("stepNbr must not be empty");
    }

    for (let i = 0; i < normalized.length; i += 1) {
      const step = normalized[i];
      if (!(step in STEP_TO_FUNCTION_CODE)) {
        throw new BadRequestException("stepNbr only supports values from 1 to 6");
      }
      if (i > 0 && step !== normalized[i - 1] + 1) {
        throw new BadRequestException("stepNbr must be a continuous range (example: [1,2,3] or [3,4])");
      }
    }
    return normalized;
  }

  private translateWorkRoot(): string {
    return resolveTranslateWorkRoot();
  }

  private isInsideRoot(root: string, target: string): boolean {
    const rel = relative(resolve(root), resolve(target));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  }

  private normalizeResultPath(resultPath: string): string {
    if (!resultPath || resultPath.trim().length === 0) {
      throw new BadRequestException("resultPath is required");
    }

    const normalized = resolve(resultPath.trim());
    const slash = normalized.replaceAll("\\", "/");
    const inLegacyWorkspace = slash.split("/").includes("workspace");
    const inWorkRoot = this.isInsideRoot(this.translateWorkRoot(), normalized);
    if (!inLegacyWorkspace && !inWorkRoot) {
      throw new BadRequestException("resultPath must point to translate work folder");
    }

    return normalized;
  }

  async readRuntimeLog(input: {
    translateHistoryId?: string;
    fileName?: string;
    tailLines?: number;
  }): Promise<{
    exists: boolean;
    logPath: string;
    updatedAt: string | null;
    content: string;
  }> {
    const historyId = String(input.translateHistoryId || "").trim();
    const fileName = String(input.fileName || "").trim();
    if (!historyId && !fileName) {
      throw new BadRequestException("translateHistoryId or fileName is required");
    }

    let logPath: string;
    if (historyId) {
      const history = await this.getById(historyId);
      if (!history) {
        throw new NotFoundException(`Translate history ${historyId} not found`);
      }
      logPath = this.resolveRuntimeLogPath(history);
    } else {
      const { workDir } = this.resolveWorkspaceLocation(fileName);
      logPath = join(workDir, "logs", "pipeline.log");
    }

    return this.readPipelineLogFile(logPath, input.tailLines);
  }

  private readPipelineLogFile(
    logPath: string,
    tailLinesRaw?: number,
  ): {
    exists: boolean;
    logPath: string;
    updatedAt: string | null;
    content: string;
  } {
    const publicLogPath = this.toPublicWorkspacePath(logPath);
    if (!existsSync(logPath)) {
      return {
        exists: false,
        logPath: publicLogPath,
        updatedAt: null,
        content: "",
      };
    }

    const tailLines = this.normalizeTailLines(tailLinesRaw);
    const text = readFileSync(logPath, "utf8");
    const content = this.tailTextByLines(text, tailLines);
    const stats = statSync(logPath);
    return {
      exists: true,
      logPath: publicLogPath,
      updatedAt: stats.mtime.toISOString(),
      content,
    };
  }

  private resolveWorkspaceDir(normalizedResultPath: string): string {
    const normalizedSlashPath = normalizedResultPath.replaceAll("\\", "/");
    const workspaceMatch = normalizedSlashPath.match(/^(.*\/workspace\/[^/]+)(?:\/.*)?$/);
    if (workspaceMatch?.[1]) {
      return workspaceMatch[1].replaceAll("/", sep);
    }

    const rootSlash = this.translateWorkRoot().replaceAll("\\", "/").replace(/\/+$/, "");
    if (normalizedSlashPath.toLowerCase().startsWith(`${rootSlash.toLowerCase()}/`)) {
      const rest = normalizedSlashPath.slice(rootSlash.length + 1);
      const workName = rest.split("/")[0];
      if (workName) {
        return join(this.translateWorkRoot(), workName);
      }
    }

    throw new BadRequestException("resultPath must contain a translate job folder");
  }

  private resolveRuntimeLogPath(history: TranslateHistory): string {
    if (history.resultPath) {
      const normalizedResultPath = this.normalizeResultPath(history.resultPath);
      const workspaceDir = this.resolveWorkspaceDir(normalizedResultPath);
      return join(workspaceDir, "logs", "pipeline.log");
    }

    const engineConfig = history.engineConfig ?? {};
    const localPath = this.pickConfigValue(engineConfig, ["localVideoPath", "local_video_path"]);
    if (typeof localPath !== "string" || !localPath.trim()) {
      throw new BadRequestException("Cannot resolve runtime log path: engineConfig.localVideoPath is missing");
    }

    const workRoot = resolveTranslateWorkRoot();
    const workName = basename(resolve(localPath.trim()), extname(resolve(localPath.trim())));
    return join(workRoot, workName, "logs", "pipeline.log");
  }

  private normalizeTailLines(value: number | undefined): number {
    if (value === undefined || Number.isNaN(Number(value))) {
      return 200;
    }
    return Math.min(Math.max(Number(value), 1), 2000);
  }

  private tailTextByLines(text: string, tailLines: number): string {
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    if (lines.length <= tailLines) {
      return normalized;
    }
    return lines.slice(lines.length - tailLines).join("\n");
  }

  private toPublicWorkspacePath(absPath: string): string {
    const normalized = String(absPath || "").replaceAll("\\", "/");
    const marker = "/workspace/";
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) {
      return `/tools/translates${normalized.slice(markerIndex)}`;
    }
    return normalized;
  }

  /**
   * Validate giọng mẫu OmniVoice/VoxCPM2 và rewrite engineConfig:
   * - omnivoiceRefWav → absolute path (clone nằm dưới voice/{userId}/)
   * - omnivoiceRefText → bổ sung từ DB/sidecar nếu thiếu
   * - omnivoiceLanguage → từ FE, hoặc DB clone, hoặc mặc định vietnamese (preset)
   */
  private async validateOmnivoiceConfigForTranslate(
    steps: number[],
    engineConfig: TranslateEngineConfigDto | null | undefined,
    userId: string,
  ): Promise<void> {
    if (!steps.includes(3) || !engineConfig) {
      return;
    }

    const config = engineConfig as Record<string, unknown>;
    const ttsEngine = String(
      this.pickConfigValue(config, ["step3TtsEngine", "step3_tts_engine"]) ?? "edge",
    ).toLowerCase();
    if (ttsEngine !== "omnivoice" && ttsEngine !== "voxcpm2") {
      return;
    }

    const refWav = String(
      this.pickConfigValue(config, ["omnivoiceRefWav", "omnivoice_ref_wav"]) ?? "",
    ).trim();
    const refText = String(
      this.pickConfigValue(config, ["omnivoiceRefText", "omnivoice_ref_text"]) ?? "",
    ).trim();

    const verified = await this.audioService.assertPipelineVoiceReady(
      refWav,
      refText || undefined,
      userId,
    );

    const absolutePath = verified.absolutePath.replace(/\\/g, "/");
    config.omnivoiceRefWav = absolutePath;
    if ("omnivoice_ref_wav" in config) {
      config.omnivoice_ref_wav = absolutePath;
    }

    if (!refText && verified.refText) {
      config.omnivoiceRefText = verified.refText;
      if ("omnivoice_ref_text" in config) {
        config.omnivoice_ref_text = verified.refText;
      }
    }

    const fromConfig = String(
      this.pickConfigValue(config, ["omnivoiceLanguage", "omnivoice_language"]) ?? "",
    ).trim();
    let language: string;
    try {
      if (fromConfig) {
        language = resolveOmnivoiceLanguageValue(fromConfig);
      } else if (verified.omnivoiceLanguage?.trim()) {
        language = resolveOmnivoiceLanguageValue(verified.omnivoiceLanguage);
      } else {
        language = "vietnamese";
      }
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Invalid omnivoice language");
    }
    config.omnivoiceLanguage = language;
    if ("omnivoice_language" in config) {
      config.omnivoice_language = language;
    }
  }

  private pickConfigValue(engineConfig: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
      if (key in engineConfig) {
        return engineConfig[key];
      }
    }
    return undefined;
  }

  private normalizeFsPath(raw: string): string {
    return resolve(raw.trim()).replaceAll("\\", "/").toLowerCase();
  }

  private expectedTranslateResultName(localVideoPath: string): string {
    const abs = resolve(localVideoPath.trim());
    return `${basename(abs, extname(abs))}_vs_tm.mp4`.toLowerCase();
  }

  private async findReusableHistory(
    userId: string,
    engineConfig: Record<string, unknown>,
  ): Promise<TranslateHistory | null> {
    const localPathRaw = this.pickConfigValue(engineConfig, ["localVideoPath", "local_video_path"]);
    if (typeof localPathRaw !== "string" || !localPathRaw.trim()) {
      return null;
    }
    const normPath = this.normalizeFsPath(localPathRaw);
    const expectedName = this.expectedTranslateResultName(localPathRaw);
    const sourceName = basename(resolve(localPathRaw.trim())).toLowerCase();

    const rows = await this.translateRepository
      .createQueryBuilder("h")
      .where("h.user_id = :userId", { userId })
      .andWhere("h.deleted_at IS NULL")
      .andWhere(
        `
        LOWER(REPLACE(COALESCE(h.engine_config->>'localVideoPath', h.engine_config->>'local_video_path', ''), chr(92), '/')) = :normPath
        AND (
          LOWER(COALESCE(h.result_file_name, '')) = :expectedName
          OR COALESCE(h.result_file_name, '') = ''
          OR LOWER(COALESCE(h.result_file_name, '')) = :sourceName
        )
        `,
        { normPath, expectedName, sourceName },
      )
      .orderBy("h.updated_at", "DESC")
      .getMany();

    return rows[0] ?? null;
  }
}
