import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ChildProcess, spawn } from "child_process";
import { Queue } from "bullmq";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { unlink } from "fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { Repository } from "typeorm";

import { NotificationType, QueueJobStatus } from "../../common/enums/domain.enums";
import { CreditHistory } from "../credits/credit-history.entity";
import { LogsService } from "../logs/logs.service";
import { NotificationsService } from "../notifications/notifications.service";
import { User } from "../users/user.entity";
import {
  AUDIO_CLONE_UPLOAD_DIR,
  AUDIO_MAX_TEXT_CHARS,
  AUDIO_OUTPUT_DIR,
  AUDIO_PREVIEW_CACHE_DIR,
  AUDIO_PRESET_VOICES,
  resolvePipelineVoiceDir,
  VIDEO_PIPELINE_DIR,
  findPresetVoice,
  resolveOmnivoiceLanguage,
  resolvePreviewTtsText,
} from "./audio.constants";
import { AudioCloneVoice } from "./audio-clone-voice.entity";
import { AudioHistory } from "./audio-history.entity";
import { CreateAudioJobDto } from "./dto/create-audio-job.dto";

export const AUDIO_QUEUE_NAME = "audio-tts";

const PIPELINE_VOICE_ALLOWED_EXT = new Set([".wav", ".mp3", ".m4a"]);

export type PipelineVoiceDto = {
  id?: string;
  displayName?: string;
  fileName: string;
  refText: string;
  size: number;
  updatedAt: string;
  /** Thư mục voice trên server (tools/video-pipeline/voice). */
  voiceDir?: string;
  /** Đường dẫn tuyệt đối file audio sau upload. */
  absolutePath?: string;
  /** true khi file tồn tại và size > 0 sau khi ghi. */
  verified?: boolean;
};

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);
  private readonly activeChildren = new Map<string, ChildProcess>();
  private readonly cancelledJobs = new Set<string>();

  constructor(
    @InjectQueue(AUDIO_QUEUE_NAME)
    private readonly audioQueue: Queue,
    @InjectRepository(AudioHistory, "tool")
    private readonly audioRepository: Repository<AudioHistory>,
    @InjectRepository(AudioCloneVoice, "tool")
    private readonly cloneVoiceRepository: Repository<AudioCloneVoice>,
    @InjectRepository(User, "tool")
    private readonly userRepository: Repository<User>,
    @InjectRepository(CreditHistory, "tool")
    private readonly creditHistoryRepository: Repository<CreditHistory>,
    private readonly logsService: LogsService,
    private readonly notificationsService: NotificationsService,
  ) {}

  private static readonly OMNIVOICE_INLINE_PY = [
    "import json,sys",
    "p=json.load(sys.stdin)",
    "from audio_tts_with_pauses import synthesize_with_pause_settings",
    "synthesize_with_pause_settings(**{k:v for k,v in p.items() if v is not None})",
  ].join(";");

  private static readonly MAX_LOG_BUFFER = 64 * 1024;

  private resolvePythonBin(): string {
    return (
      process.env.AUDIO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  /** Mặc định 42 — khớp OMNIVOICE_SEED trong auto_vietsub_pro.py. Set env `none` để random. */
  private resolveOmnivoiceSeed(): number | undefined {
    const raw = (process.env.OMNIVOICE_SEED ?? "42").trim();
    if (!raw || raw.toLowerCase() === "none" || raw.toLowerCase() === "null") {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : 42;
  }

  private resolveCmdTimeoutMs(): number {
    return Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600_000);
  }

  /** BullMQ lock must outlive the Python TTS subprocess (default 30s is too short). */
  static resolveQueueLockDurationMs(): number {
    const explicit = Number(process.env.AUDIO_QUEUE_LOCK_MS ?? 0);
    if (Number.isFinite(explicit) && explicit > 0) {
      return explicit;
    }
    const cmdTimeout = Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600_000);
    return cmdTimeout + 120_000;
  }

  requestCancel(audioHistoryId: string): void {
    this.cancelledJobs.add(audioHistoryId);
    const child = this.activeChildren.get(audioHistoryId);
    if (child && !child.killed) {
      this.logger.warn(`Cancelling active OmniVoice process for audio ${audioHistoryId}`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, 5_000).unref();
    }
  }

  isCancelled(audioHistoryId: string): boolean {
    return this.cancelledJobs.has(audioHistoryId);
  }

  private clearCancel(audioHistoryId: string): void {
    this.cancelledJobs.delete(audioHistoryId);
    this.activeChildren.delete(audioHistoryId);
  }

  private async spawnOmnivoiceTts(
    opts: {
      text: string;
      outWav: string;
      refAudio: string;
      refText: string;
      language?: string;
      seed?: number;
      pauseSettings?: Record<string, number>;
      playbackSpeed?: number;
    },
    audioHistoryId?: string,
  ): Promise<string> {
    const refAudio = isAbsolute(opts.refAudio) ? opts.refAudio : resolve(process.cwd(), opts.refAudio);
    if (!existsSync(refAudio)) {
      throw new Error(`Reference audio not found: ${refAudio}`);
    }

    const outWav = isAbsolute(opts.outWav) ? opts.outWav : resolve(process.cwd(), opts.outWav);

    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const timeoutMs = this.resolveCmdTimeoutMs();

    const seed = opts.seed ?? this.resolveOmnivoiceSeed();

    const payload = {
      text: opts.text,
      out_wav: outWav,
      ref_audio: refAudio,
      ref_text: opts.refText ?? "",
      model_id: (process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim(),
      device_map: (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim() || "cuda:0",
      dtype_str: (process.env.OMNIVOICE_DTYPE ?? "float16").trim(),
      language: opts.language ?? process.env.OMNIVOICE_LANGUAGE ?? "vietnamese",
      num_step: Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
      guidance_scale: Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
      ...(seed != null ? { seed } : {}),
      ...(opts.pauseSettings ? { pause_settings: opts.pauseSettings } : {}),
      ...(opts.playbackSpeed != null && Math.abs(opts.playbackSpeed - 1) > 1e-6
        ? { playback_speed: opts.playbackSpeed }
        : {}),
    };

    const pythonBin = this.resolvePythonBin();

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, ["-c", AudioService.OMNIVOICE_INLINE_PY], {
        cwd: scriptDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (audioHistoryId) {
        this.activeChildren.set(audioHistoryId, child);
      }

      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`OmniVoice TTS timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (audioHistoryId) {
          this.activeChildren.delete(audioHistoryId);
        }
      };

      child.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
        if (stderr.length > AudioService.MAX_LOG_BUFFER) {
          stderr = stderr.slice(-AudioService.MAX_LOG_BUFFER);
        }
      });
      child.on("error", (err) => {
        cleanup();
        rejectPromise(err);
      });
      child.on("close", (code, signal) => {
        cleanup();
        if (audioHistoryId && this.isCancelled(audioHistoryId)) {
          rejectPromise(new Error("Audio generation cancelled"));
          return;
        }
        if (code !== 0) {
          const suffix = signal ? ` (signal ${signal})` : "";
          rejectPromise(new Error(stderr.trim() || `OmniVoice exited with code ${code}${suffix}`));
          return;
        }
        resolvePromise();
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    if (!existsSync(outWav)) {
      throw new Error(`OmniVoice did not produce output: ${outWav}`);
    }
    return outWav;
  }

  /** Tìm file trong voice dir (khớp tên không phân biệt hoa thường). */
  private findVoiceFileOnDisk(fileName: string): string | null {
    const dir = this.resolvePipelineVoiceDir();
    const safeName = basename(fileName);
    if (!safeName || !existsSync(dir)) return null;

    const exact = join(dir, safeName);
    if (existsSync(exact)) return exact;

    const target = safeName.toLowerCase();
    const found = readdirSync(dir).find((name) => name.toLowerCase() === target);
    return found ? join(dir, found) : null;
  }

  listPresetVoices() {
    return AUDIO_PRESET_VOICES.map((voice) => ({
      id: voice.id,
      name: voice.name,
      tags: voice.tags,
      language: voice.language,
      gender: voice.gender,
      avatar: voice.avatar,
      previewUrl: `/api/tools/audio/voices/${voice.id}/preview`,
    }));
  }

  getPresetVoice(voiceId: string) {
    const voice = findPresetVoice(voiceId);
    if (!voice) {
      throw new NotFoundException(`Voice preset not found: ${voiceId}`);
    }
    return voice;
  }

  resolvePresetRefAudioPath(refWav: string): string {
    const path = this.findVoiceFileOnDisk(refWav);
    if (!path) {
      throw new BadRequestException(`Preset reference audio missing on server: ${basename(refWav)}`);
    }
    return path;
  }

  private sanitizeVoiceFileStem(raw: string): string {
    return (
      raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\\/:*?"<>|]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/[^\w.-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_|_$/g, "")
        .trim() || `voice_${Date.now()}`
    );
  }

  private resolvePipelineVoiceDir(): string {
    return resolvePipelineVoiceDir();
  }

  private ensurePipelineVoiceDir(): string {
    const dir = this.resolvePipelineVoiceDir();
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o775 });
    }
    return dir;
  }

  /** Kiểm tra file giọng mẫu nằm đúng tools/video-pipeline/voice (dùng cho translate Step3). */
  async assertPipelineVoiceReady(
    refWav: string,
    refTextOverride?: string,
  ): Promise<{ fileName: string; voiceDir: string; absolutePath: string; refText: string }> {
    const fileName = basename(String(refWav || "").trim());
    if (!fileName) {
      throw new BadRequestException("omnivoiceRefWav is required");
    }
    const ext = extname(fileName).toLowerCase();
    if (!PIPELINE_VOICE_ALLOWED_EXT.has(ext)) {
      throw new BadRequestException(
        `Invalid omnivoiceRefWav "${fileName}": only .wav, .mp3, .m4a are allowed.`,
      );
    }

    const row = await this.cloneVoiceRepository.findOne({ where: { fileName } });
    const voiceDir = this.resolvePipelineVoiceDir();
    const absolutePath = row?.filePath
      ? isAbsolute(row.filePath)
        ? row.filePath
        : resolve(process.cwd(), row.filePath)
      : join(voiceDir, fileName);

    if (!existsSync(absolutePath)) {
      throw new BadRequestException(
        `Voice sample not found: ${fileName}. Expected under ${voiceDir.replace(/\\/g, "/")}. Upload via Clone Voice menu.`,
      );
    }

    const stats = statSync(absolutePath);
    if (!stats.isFile() || stats.size <= 0) {
      throw new BadRequestException(`Voice sample is empty or invalid: ${fileName}`);
    }

    const refText =
      String(refTextOverride || "").trim() ||
      row?.refText?.trim() ||
      this.readPipelineVoiceRefText(fileName);
    if (!refText) {
      throw new BadRequestException(
        `Missing ref text for voice "${fileName}". Upload with refText or add ${basename(fileName, ext)}.ref.txt in voice folder.`,
      );
    }

    return {
      fileName,
      voiceDir,
      absolutePath,
      refText,
    };
  }

  resolveCloneRefAudioPath(userId: string, fileName: string): string {
    const safeName = basename(fileName);
    const path = resolve(AUDIO_CLONE_UPLOAD_DIR, userId, safeName);
    if (!existsSync(path)) {
      throw new BadRequestException(`Clone reference audio not found: ${safeName}`);
    }
    return path;
  }

  private pipelineVoiceRefSidecarPath(fileName: string): string {
    const safeName = basename(fileName);
    const stem = basename(safeName, extname(safeName));
    return join(this.resolvePipelineVoiceDir(), `${stem}.ref.txt`);
  }

  readPipelineVoiceRefText(fileName: string): string {
    const sidecar = this.pipelineVoiceRefSidecarPath(fileName);
    if (!existsSync(sidecar)) {
      return "";
    }
    return readFileSync(sidecar, "utf8").trim();
  }

  writePipelineVoiceRefText(fileName: string, refText: string): void {
    const trimmed = String(refText || "").trim();
    if (!trimmed) {
      throw new BadRequestException("refText is required");
    }
    writeFileSync(this.pipelineVoiceRefSidecarPath(fileName), trimmed, "utf8");
  }

  private mapCloneVoiceRow(row: AudioCloneVoice): PipelineVoiceDto {
    const abs = isAbsolute(row.filePath) ? row.filePath : resolve(process.cwd(), row.filePath);
    const sizeOnDisk = existsSync(abs) ? statSync(abs).size : row.fileSize;
    return {
      id: row.id,
      displayName: row.displayName,
      fileName: row.fileName,
      refText: row.refText,
      size: sizeOnDisk,
      updatedAt: row.updatedAt.toISOString(),
      voiceDir: this.resolvePipelineVoiceDir().replace(/\\/g, "/"),
      absolutePath: abs.replace(/\\/g, "/"),
      verified: existsSync(abs) && sizeOnDisk > 0,
    };
  }

  async listPipelineVoices(): Promise<PipelineVoiceDto[]> {
    const rows = await this.cloneVoiceRepository.find({
      order: { updatedAt: "DESC" },
    });
    return rows.map((row) => this.mapCloneVoiceRow(row));
  }

  async savePipelineVoiceUpload(input: {
    originalName: string;
    voiceName?: string;
    refText: string;
    buffer: Buffer;
    userId?: string;
  }): Promise<PipelineVoiceDto> {
    const refText = String(input.refText || "").trim();
    if (!refText) {
      throw new BadRequestException("refText is required");
    }

    const bufferSize = input.buffer?.length ?? 0;
    if (bufferSize <= 0) {
      throw new BadRequestException("Uploaded file is empty (0 bytes). Check multipart upload includes audio data.");
    }

    const ext = extname(input.originalName).toLowerCase();
    if (!PIPELINE_VOICE_ALLOWED_EXT.has(ext)) {
      throw new BadRequestException("Only .wav, .mp3, .m4a are allowed.");
    }

    const displayName =
      String(input.voiceName || "").trim() ||
      basename(input.originalName, extname(input.originalName));
    const safeBase = this.sanitizeVoiceFileStem(displayName);
    const fileName = `${safeBase}${ext}`;

    const dir = this.ensurePipelineVoiceDir();
    const abs = join(dir, fileName);
    try {
      writeFileSync(abs, input.buffer);
      this.writePipelineVoiceRefText(fileName, refText);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
      if (code === "EACCES" || code === "EPERM") {
        throw new BadRequestException(
          `Cannot write to ${dir.replace(/\\/g, "/")}. Grant write permission to the Nest process user, e.g. chown -R www-data tools/video-pipeline/voice`,
        );
      }
      throw err;
    }

    const verified = await this.assertPipelineVoiceReady(fileName, refText);
    const stats = statSync(abs);
    const relativePath = join("tools", "video-pipeline", "voice", fileName).replace(/\\/g, "/");
    const mimeType =
      ext === ".mp3" ? "audio/mpeg" : ext === ".m4a" ? "audio/mp4" : ext === ".wav" ? "audio/wav" : null;

    let userId: string | null = null;
    if (input.userId?.trim()) {
      const user = await this.userRepository.findOne({ where: { id: input.userId.trim() } });
      userId = user?.id ?? null;
    }

    const existing = await this.cloneVoiceRepository.findOne({ where: { fileName } });
    const row = existing
      ? Object.assign(existing, {
          displayName,
          refText,
          filePath: relativePath,
          fileSize: stats.size,
          mimeType,
          userId: userId ?? existing.userId,
        })
      : this.cloneVoiceRepository.create({
          displayName,
          fileName,
          refText,
          filePath: relativePath,
          fileSize: stats.size,
          mimeType,
          userId,
        });

    const saved = await this.cloneVoiceRepository.save(row);
    return {
      ...this.mapCloneVoiceRow(saved),
      voiceDir: verified.voiceDir.replace(/\\/g, "/"),
      absolutePath: verified.absolutePath.replace(/\\/g, "/"),
      verified: true,
    };
  }

  private async resolveCloneReference(
    dto: CreateAudioJobDto,
  ): Promise<{ refAudioPath: string; refText: string }> {
    if (dto.pipelineRefWav?.trim()) {
      const verified = await this.assertPipelineVoiceReady(
        dto.pipelineRefWav.trim(),
        dto.cloneRefText?.trim(),
      );
      return { refAudioPath: verified.absolutePath, refText: verified.refText };
    }

    if (!dto.cloneRefWav || !dto.cloneRefText?.trim()) {
      throw new BadRequestException("cloneRefWav and cloneRefText are required for clone mode");
    }
    return {
      refAudioPath: this.resolveCloneRefAudioPath(dto.userId, dto.cloneRefWav),
      refText: dto.cloneRefText.trim(),
    };
  }

  getPreviewCachePath(voiceId: string): string {
    return resolve(AUDIO_PREVIEW_CACHE_DIR, `${voiceId}.wav`);
  }

  private guessAudioMimeFromPath(filePath: string): string {
    const lower = filePath.toLowerCase();
    if (lower.endsWith(".mp3")) return "audio/mpeg";
    if (lower.endsWith(".wav")) return "audio/wav";
    if (lower.endsWith(".m4a")) return "audio/mp4";
    return "application/octet-stream";
  }

  /**
   * Đảm bảo có file để stream cho `/preview`: ưu tiên cache WAV (OmniVoice TTS).
   * Nếu OmniVoice lỗi, trả về file mẫu gốc (MP3/WAV) để UI vẫn phát được demo.
   */
  async ensureVoicePreview(voiceId: string): Promise<{ filePath: string; contentType: string }> {
    const voice = this.getPresetVoice(voiceId);
    const cachePath = this.getPreviewCachePath(voiceId);
    const refPath = this.resolvePresetRefAudioPath(voice.refWav);
    const refMime = this.guessAudioMimeFromPath(refPath);

    if (existsSync(cachePath)) {
      const cacheStat = statSync(cachePath);
      const refStat = statSync(refPath);
      if (cacheStat.mtimeMs >= refStat.mtimeMs) {
        return { filePath: cachePath, contentType: "audio/wav" };
      }
    }

    mkdirSync(resolve(cachePath, ".."), { recursive: true });
    const previewText = resolvePreviewTtsText(voice);
    const omnivoiceLang = resolveOmnivoiceLanguage(voice);

    try {
      await this.spawnOmnivoiceTts({
        text: previewText,
        outWav: cachePath,
        refAudio: refPath,
        refText: voice.refText,
        language: omnivoiceLang,
      });
      return { filePath: cachePath, contentType: "audio/wav" };
    } catch (err) {
      this.logger.warn(
        `OmniVoice preview failed for preset "${voiceId}", falling back to reference clip (${voice.refWav})`,
        err instanceof Error ? err.stack : String(err),
      );
      return { filePath: refPath, contentType: refMime };
    }
  }

  async enqueue(dto: CreateAudioJobDto): Promise<AudioHistory> {
    const text = dto.text.trim();
    if (!text) {
      throw new BadRequestException("text is required");
    }
    if (text.length > AUDIO_MAX_TEXT_CHARS) {
      throw new BadRequestException(`text exceeds ${AUDIO_MAX_TEXT_CHARS} characters`);
    }

    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    let refAudioPath: string;
    let refText: string;
    let voiceId: string | null = null;

    if (dto.voiceMode === "preset") {
      if (!dto.voiceId) {
        throw new BadRequestException("voiceId is required for preset mode");
      }
      const preset = this.getPresetVoice(dto.voiceId);
      voiceId = preset.id;
      refAudioPath = this.resolvePresetRefAudioPath(preset.refWav);
      refText = preset.refText;
    } else {
      const resolved = await this.resolveCloneReference(dto);
      refAudioPath = resolved.refAudioPath;
      refText = resolved.refText;
    }

    const estimatedCost = dto.estimatedCost ?? 0;

    const displayName = text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;

    const history = this.audioRepository.create({
      userId: dto.userId,
      inputText: text,
      displayName,
      voiceMode: dto.voiceMode,
      voiceId,
      engineConfig: {
        refAudioPath,
        refText,
        speed: dto.speed ?? 1,
        pauseSettings: {
          period: dto.pausePeriodSec ?? 0.45,
          comma: dto.pauseCommaSec ?? 0.25,
          semicolon: dto.pauseSemicolonSec ?? 0.3,
          newline: dto.pauseNewlineSec ?? 0.6,
          question: dto.pauseQuestionSec ?? 0.45,
          exclamation: dto.pauseExclamationSec ?? 0.45,
          colon: dto.pauseColonSec ?? 0.3,
          ellipsis: dto.pauseEllipsisSec ?? 0.55,
        },
        cloneRefWav: dto.cloneRefWav ?? dto.pipelineRefWav ?? null,
      },
      status: QueueJobStatus.PENDING,
      cost: estimatedCost.toFixed(2),
      queueJobId: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    const created = await this.audioRepository.save(history);

    const queueJob = await this.audioQueue.add(
      AUDIO_QUEUE_NAME,
      { audioHistoryId: created.id },
      { attempts: 2, removeOnComplete: true, removeOnFail: 50 },
    );
    created.queueJobId = queueJob.id ? String(queueJob.id) : null;
    const saved = await this.audioRepository.save(created);

    await this.logsService.createLog({
      userId: user.id,
      action: "audio.queued",
      payload: {
        audioHistoryId: saved.id,
        queueJobId: saved.queueJobId,
        voiceMode: saved.voiceMode,
        voiceId: saved.voiceId,
      },
      ip: user.ip,
    });

    return saved;
  }

  async getHistory(
    userId: string,
    options?: { page?: number; limit?: number },
  ): Promise<{ items: AudioHistory[]; total: number; page: number; limit: number; hasMore: boolean }> {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const limit = Math.min(50, Math.max(1, Number(options?.limit ?? 20) || 20));
    const [items, total] = await this.audioRepository.findAndCount({
      where: { userId },
      order: { createdAt: "DESC" },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      items,
      total,
      page,
      limit,
      hasMore: page * limit < total,
    };
  }

  async getById(id: string): Promise<AudioHistory | null> {
    return this.audioRepository.findOne({ where: { id } });
  }

  async deleteHistory(userId: string, id: string): Promise<void> {
    const row = await this.audioRepository.findOne({ where: { id, userId } });
    if (!row) {
      throw new NotFoundException("Job not found");
    }

    if (row.status === QueueJobStatus.PENDING || row.status === QueueJobStatus.RUNNING) {
      this.requestCancel(id);
    }

    if (row.queueJobId) {
      try {
        const job = await this.audioQueue.getJob(row.queueJobId);
        if (job) {
          const state = await job.getState();
          if (state === "waiting" || state === "delayed") {
            await job.remove();
          } else if (state === "active") {
            this.logger.warn(
              `Queue job ${row.queueJobId} for audio ${id} is active; OmniVoice process cancelled, queue entry will clear when worker finishes`,
            );
          } else {
            await job.remove();
          }
        }
      } catch (err) {
        this.logger.warn(
          `Could not remove queue job ${row.queueJobId} for audio ${id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (row.resultPath) {
      try {
        const abs = isAbsolute(row.resultPath) ? row.resultPath : resolve(process.cwd(), row.resultPath);
        if (existsSync(abs)) {
          await unlink(abs);
        }
      } catch (err) {
        this.logger.warn(
          `Could not delete audio file for history ${id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await this.audioRepository.delete({ id, userId });
    this.clearCancel(id);

    await this.logsService.createLog({
      userId,
      action: "audio.deleted",
      payload: { audioHistoryId: id, displayName: row.displayName },
    });
  }

  async deleteAllHistory(userId: string): Promise<{ deleted: number }> {
    const rows = await this.audioRepository.find({ where: { userId } });
    for (const row of rows) {
      await this.deleteHistory(userId, row.id);
    }
    return { deleted: rows.length };
  }

  mapHistoryForClient(row: AudioHistory) {
    return {
      id: row.id,
      name: row.displayName,
      detail: row.voiceMode === "preset" ? "Giọng mẫu" : "Clone",
      completed: row.status === QueueJobStatus.COMPLETED,
      status: row.status,
      voiceMode: row.voiceMode,
      voiceId: row.voiceId,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      downloadUrl:
        row.status === QueueJobStatus.COMPLETED && row.id ? `/api/tools/audio/jobs/${row.id}/download` : null,
      playUrl: row.status === QueueJobStatus.COMPLETED && row.id ? `/api/tools/audio/jobs/${row.id}/stream` : null,
    };
  }

  async processStarted(audioHistoryId: string): Promise<void> {
    await this.audioRepository.update({ id: audioHistoryId }, { status: QueueJobStatus.RUNNING, errorMessage: null });
  }

  async processCompleted(audioHistoryId: string, resultPath: string): Promise<void> {
    const history = await this.audioRepository.findOne({ where: { id: audioHistoryId } });
    if (!history) return;

    history.status = QueueJobStatus.COMPLETED;
    history.resultPath = resultPath;
    history.resultFileName = basename(resultPath);
    history.errorMessage = null;
    await this.audioRepository.save(history);

    const user = await this.userRepository.findOne({ where: { id: history.userId } });
    if (!user) return;

    const current = Number(user.credit);
    const next = Math.max(current - Number(history.cost), 0);
    user.credit = next.toFixed(2);
    await this.userRepository.save(user);

    await this.creditHistoryRepository.save(
      this.creditHistoryRepository.create({
        userId: user.id,
        amount: (-Number(history.cost)).toFixed(2),
        balance: user.credit,
        reason: "generate_audio_tts",
        metadata: { audioHistoryId: history.id },
      }),
    );

    await this.notificationsService.push({
      userId: user.id,
      title: "Tạo audio hoàn tất",
      message: `Audio "${history.displayName}" đã sẵn sàng.`,
      type: NotificationType.SUCCESS,
    });
  }

  async processFailed(audioHistoryId: string, errorMessage: string): Promise<void> {
    this.logger.error(`Audio failed: historyId=${audioHistoryId} error=${errorMessage}`);
    await this.audioRepository.update({ id: audioHistoryId }, { status: QueueJobStatus.FAILED, errorMessage });
  }

  resolveResultPath(history: AudioHistory): string {
    if (!history.resultPath) {
      throw new NotFoundException("Audio result not ready");
    }
    const abs = isAbsolute(history.resultPath) ? history.resultPath : resolve(process.cwd(), history.resultPath);
    if (!existsSync(abs)) {
      throw new NotFoundException("Audio file not found on server");
    }
    return abs;
  }

  buildOutputPath(userId: string, audioHistoryId: string): string {
    const dir = resolve(AUDIO_OUTPUT_DIR, userId);
    mkdirSync(dir, { recursive: true });
    return join(dir, `${audioHistoryId}.wav`);
  }

  async runGeneration(history: AudioHistory): Promise<string> {
    const config = (history.engineConfig ?? {}) as Record<string, unknown>;
    const refAudioPath = String(config.refAudioPath ?? "");
    const refText = String(config.refText ?? "");
    if (!refAudioPath) {
      throw new Error("engine_config.refAudioPath is missing");
    }

    const outPath = this.buildOutputPath(history.userId, history.id);
    const preset = history.voiceId ? findPresetVoice(history.voiceId) : undefined;
    const language = preset ? resolveOmnivoiceLanguage(preset) : (process.env.OMNIVOICE_LANGUAGE ?? "vietnamese");

    const pauseSettings =
      config.pauseSettings && typeof config.pauseSettings === "object"
        ? (config.pauseSettings as Record<string, number>)
        : undefined;
    const rawSpeed = Number(config.speed ?? 1);
    const playbackSpeed = Number.isFinite(rawSpeed) ? Math.min(2, Math.max(0.5, rawSpeed)) : 1;

    await this.spawnOmnivoiceTts(
      {
        text: history.inputText,
        outWav: outPath,
        refAudio: refAudioPath,
        refText,
        language,
        pauseSettings,
        playbackSpeed,
      },
      history.id,
    );

    return outPath.replaceAll("\\", "/");
  }
}
