import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ChildProcess, spawn } from "child_process";
import { Queue } from "bullmq";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { unlink } from "fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "path";
import { Repository, SelectQueryBuilder } from "typeorm";

import { QueueJobStatus } from "../../common/enums/domain.enums";
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
  resolveOmnivoiceLanguageValue,
  resolvePreviewTtsText,
} from "./audio.constants";
import { AudioCloneVoice } from "./audio-clone-voice.entity";
import { AudioHistory } from "./audio-history.entity";
import { CreateAudioFromSrtDto } from "./dto/create-audio-from-srt.dto";
import { CreateAudioJobDto } from "./dto/create-audio-job.dto";
import { ExecuteVoiceDto } from "../workflow/dto/execute-voice.dto";

export const AUDIO_QUEUE_NAME = "audio-tts";

/** engine_config.jobKind for SRT timeline jobs from Audio Studio. */
export const AUDIO_JOB_KIND_SRT_TIMELINE = "srt_timeline";

/** engine_config.source cho audio sinh từ node Voice (page Videos). */
export const AUDIO_HISTORY_SOURCE_VIDEO_VOICE = "video_voice";

/** studio = trang Audio; auto = workflow (video voice, …). */
export type AudioHistoryListSourceType = "studio" | "auto";

const PIPELINE_VOICE_ALLOWED_EXT = new Set([".wav", ".mp3", ".m4a"]);

export type PipelineVoiceDto = {
  id?: string;
  displayName?: string;
  fileName: string;
  refText: string;
  omnivoiceLanguage?: string | null;
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

  /** Mặc định 42 — khớp VOXCPM2_SEED. Set env `none` để random. */
  private resolveVoxcpm2Seed(): number | undefined {
    const raw = (process.env.VOXCPM2_SEED ?? "42").trim();
    if (!raw || raw.toLowerCase() === "none" || raw.toLowerCase() === "null") {
      return undefined;
    }
    const n = Number(raw);
    return Number.isFinite(n) ? n : 42;
  }

  private resolveTtsEngine(raw?: string | null): "omnivoice" | "voxcpm2" {
    const key = String(raw ?? "")
      .trim()
      .toLowerCase();
    return key === "voxcpm2" ? "voxcpm2" : "omnivoice";
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
      ttsEngine?: "omnivoice" | "voxcpm2";
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
    const engine = this.resolveTtsEngine(opts.ttsEngine);
    const language = opts.language
      ? resolveOmnivoiceLanguageValue(opts.language)
      : process.env.OMNIVOICE_LANGUAGE
        ? resolveOmnivoiceLanguageValue(process.env.OMNIVOICE_LANGUAGE)
        : (() => {
            throw new Error("OmniVoice language is required");
          })();

    const seed =
      opts.seed ?? (engine === "voxcpm2" ? this.resolveVoxcpm2Seed() : this.resolveOmnivoiceSeed());

    const payload =
      engine === "voxcpm2"
        ? {
            engine: "voxcpm2",
            text: opts.text,
            out_wav: outWav,
            ref_audio: refAudio,
            ref_text: opts.refText ?? "",
            model_id: (process.env.VOXCPM2_MODEL_ID ?? "openbmb/VoxCPM2").trim(),
            language,
            cfg_value: Number(process.env.VOXCPM2_CFG_VALUE ?? 2),
            inference_timesteps: Number(process.env.VOXCPM2_INFERENCE_TIMESTEPS ?? 10),
            ...(seed != null ? { seed } : {}),
            ...(opts.pauseSettings ? { pause_settings: opts.pauseSettings } : {}),
            ...(opts.playbackSpeed != null && Math.abs(opts.playbackSpeed - 1) > 1e-6
              ? { playback_speed: opts.playbackSpeed }
              : {}),
          }
        : {
            engine: "omnivoice",
            text: opts.text,
            out_wav: outWav,
            ref_audio: refAudio,
            ref_text: opts.refText ?? "",
            model_id: (process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim(),
            device_map: (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim() || "cuda:0",
            dtype_str: (process.env.OMNIVOICE_DTYPE ?? "float16").trim(),
            language,
            num_step: Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
            guidance_scale: Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
            ...(seed != null ? { seed } : {}),
            ...(opts.pauseSettings ? { pause_settings: opts.pauseSettings } : {}),
            ...(opts.playbackSpeed != null && Math.abs(opts.playbackSpeed - 1) > 1e-6
              ? { playback_speed: opts.playbackSpeed }
              : {}),
          };

    const engineLabel = engine === "voxcpm2" ? "VoxCPM2" : "OmniVoice";
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
        rejectPromise(new Error(`${engineLabel} TTS timed out after ${timeoutMs}ms`));
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
          rejectPromise(new Error(stderr.trim() || `${engineLabel} exited with code ${code}${suffix}`));
          return;
        }
        resolvePromise();
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    if (!existsSync(outWav)) {
      throw new Error(`${engineLabel} did not produce output: ${outWav}`);
    }
    return outWav;
  }

  private async spawnSrtTimelineTts(
    opts: {
      srtText: string;
      outWav: string;
      refAudio: string;
      refText: string;
      language: string;
      playbackSpeed?: number;
      fitToCue?: boolean;
      ttsEngine?: "omnivoice" | "voxcpm2";
    },
    audioHistoryId?: string,
  ): Promise<{ outWav: string; meta: Record<string, unknown> }> {
    const refAudio = isAbsolute(opts.refAudio) ? opts.refAudio : resolve(process.cwd(), opts.refAudio);
    if (!existsSync(refAudio)) {
      throw new Error(`Reference audio not found: ${refAudio}`);
    }
    const outWav = isAbsolute(opts.outWav) ? opts.outWav : resolve(process.cwd(), opts.outWav);
    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const scriptPath = resolve(scriptDir, "audio_srt_timeline_tts.py");
    if (!existsSync(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }

    const timeoutMs = Math.max(this.resolveCmdTimeoutMs(), 30 * 60_000);
    const engine = this.resolveTtsEngine(opts.ttsEngine);
    const language = resolveOmnivoiceLanguageValue(opts.language);
    const seed = engine === "voxcpm2" ? this.resolveVoxcpm2Seed() : this.resolveOmnivoiceSeed();

    const payload =
      engine === "voxcpm2"
        ? {
            engine: "voxcpm2",
            srt_text: opts.srtText,
            out_wav: outWav,
            ref_audio: refAudio,
            ref_text: opts.refText ?? "",
            model_id: (process.env.VOXCPM2_MODEL_ID ?? "openbmb/VoxCPM2").trim(),
            language,
            cfg_value: Number(process.env.VOXCPM2_CFG_VALUE ?? 2),
            inference_timesteps: Number(process.env.VOXCPM2_INFERENCE_TIMESTEPS ?? 10),
            ...(seed != null ? { seed } : {}),
            playback_speed: opts.playbackSpeed ?? 1,
            fit_to_cue: opts.fitToCue !== false,
          }
        : {
            engine: "omnivoice",
            srt_text: opts.srtText,
            out_wav: outWav,
            ref_audio: refAudio,
            ref_text: opts.refText ?? "",
            model_id: (process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim(),
            device_map: (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim() || "cuda:0",
            dtype_str: (process.env.OMNIVOICE_DTYPE ?? "float16").trim(),
            language,
            num_step: Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
            guidance_scale: Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
            ...(seed != null ? { seed } : {}),
            playback_speed: opts.playbackSpeed ?? 1,
            fit_to_cue: opts.fitToCue !== false,
          };

    const pythonBin = this.resolvePythonBin();
    let stdout = "";

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [scriptPath], {
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
        rejectPromise(new Error(`SRT timeline TTS timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (audioHistoryId) {
          this.activeChildren.delete(audioHistoryId);
        }
      };

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
        if (stdout.length > AudioService.MAX_LOG_BUFFER) {
          stdout = stdout.slice(-AudioService.MAX_LOG_BUFFER);
        }
      });
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
          rejectPromise(new Error(stderr.trim() || `SRT timeline exited with code ${code}${suffix}`));
          return;
        }
        resolvePromise();
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    if (!existsSync(outWav)) {
      throw new Error(`SRT timeline did not produce output: ${outWav}`);
    }

    let meta: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "{}") as Record<string, unknown>;
      if (parsed && typeof parsed === "object") meta = parsed;
    } catch {
      meta = {};
    }
    return { outWav, meta };
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

  private ensurePipelineVoiceDir(userId?: string): string {
    const root = this.resolvePipelineVoiceDir();
    const dir = userId?.trim() ? join(root, userId.trim()) : root;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o775 });
    }
    return dir;
  }

  private async requireCloneVoiceOwner(userId: string): Promise<string> {
    const id = String(userId || "").trim();
    if (!id) {
      throw new BadRequestException("userId is required");
    }
    const user = await this.userRepository.findOne({ where: { id } });
    if (!user) {
      throw new BadRequestException("User not found");
    }
    return user.id;
  }

  private resolvePipelineVoiceAbsolutePath(
    row: AudioCloneVoice | null,
    fileName: string,
    ownerUserId?: string,
  ): { voiceDir: string; absolutePath: string } {
    const rootDir = this.resolvePipelineVoiceDir();
    if (row?.filePath) {
      const absolutePath = isAbsolute(row.filePath)
        ? row.filePath
        : resolve(process.cwd(), row.filePath);
      const voiceDir = row.userId ? join(rootDir, row.userId) : rootDir;
      return { voiceDir, absolutePath };
    }
    if (ownerUserId?.trim()) {
      const voiceDir = join(rootDir, ownerUserId.trim());
      return { voiceDir, absolutePath: join(voiceDir, fileName) };
    }
    return { voiceDir: rootDir, absolutePath: join(rootDir, fileName) };
  }

  /**
   * Kiểm tra file giọng mẫu.
   * - Có ownerUserId: chỉ chấp nhận clone thuộc user đó, hoặc file preset dùng chung ở thư mục root.
   * - Không có ownerUserId: chỉ chấp nhận file ở root (preset / legacy).
   */
  async assertPipelineVoiceReady(
    refWav: string,
    refTextOverride?: string,
    ownerUserId?: string,
  ): Promise<{
    fileName: string;
    voiceDir: string;
    absolutePath: string;
    refText: string;
    omnivoiceLanguage: string | null;
  }> {
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

    const owner = ownerUserId?.trim() || "";
    let row: AudioCloneVoice | null = null;
    if (owner) {
      row = await this.cloneVoiceRepository.findOne({
        where: { fileName, userId: owner },
      });
    }

    const rootDir = this.resolvePipelineVoiceDir();
    let voiceDir = rootDir;
    let absolutePath = join(rootDir, fileName);

    if (row) {
      const resolved = this.resolvePipelineVoiceAbsolutePath(row, fileName, owner);
      voiceDir = resolved.voiceDir;
      absolutePath = resolved.absolutePath;
    } else if (owner) {
      const ownedPath = join(rootDir, owner, fileName);
      if (existsSync(ownedPath)) {
        voiceDir = join(rootDir, owner);
        absolutePath = ownedPath;
      } else if (!existsSync(absolutePath)) {
        throw new BadRequestException(
          `Voice sample not found or not owned by this user: ${fileName}. Upload via Clone Voice menu.`,
        );
      }
    } else if (!existsSync(absolutePath)) {
      throw new BadRequestException(
        `Voice sample not found: ${fileName}. Expected under ${rootDir.replace(/\\/g, "/")}.`,
      );
    }

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
      this.readPipelineVoiceRefText(fileName, row?.userId ?? (owner || null));
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
      omnivoiceLanguage: row?.omnivoiceLanguage?.trim() || null,
    };
  }

  async resolvePipelineVoiceLanguage(fileName: string, ownerUserId?: string): Promise<string> {
    const safeName = basename(String(fileName || "").trim());
    const owner = ownerUserId?.trim();
    const row = owner
      ? await this.cloneVoiceRepository.findOne({ where: { fileName: safeName, userId: owner } })
      : await this.cloneVoiceRepository.findOne({ where: { fileName: safeName } });
    if (!row?.omnivoiceLanguage?.trim()) {
      throw new BadRequestException(
        `Giọng clone "${safeName}" chưa có ngôn ngữ. Tạo lại giọng và chọn Việt/Anh/Hàn/Nhật.`,
      );
    }
    return resolveOmnivoiceLanguageValue(row.omnivoiceLanguage);
  }

  resolveCloneRefAudioPath(userId: string, fileName: string): string {
    const safeName = basename(fileName);
    const path = resolve(AUDIO_CLONE_UPLOAD_DIR, userId, safeName);
    if (!existsSync(path)) {
      throw new BadRequestException(`Clone reference audio not found: ${safeName}`);
    }
    return path;
  }

  private pipelineVoiceRefSidecarPath(fileName: string, userId?: string | null): string {
    const safeName = basename(fileName);
    const stem = basename(safeName, extname(safeName));
    const dir = userId?.trim()
      ? join(this.resolvePipelineVoiceDir(), userId.trim())
      : this.resolvePipelineVoiceDir();
    return join(dir, `${stem}.ref.txt`);
  }

  readPipelineVoiceRefText(fileName: string, userId?: string | null): string {
    const sidecar = this.pipelineVoiceRefSidecarPath(fileName, userId);
    if (!existsSync(sidecar)) {
      return "";
    }
    return readFileSync(sidecar, "utf8").trim();
  }

  writePipelineVoiceRefText(fileName: string, refText: string, userId?: string | null): void {
    const trimmed = String(refText || "").trim();
    if (!trimmed) {
      throw new BadRequestException("refText is required");
    }
    writeFileSync(this.pipelineVoiceRefSidecarPath(fileName, userId), trimmed, "utf8");
  }

  private mapCloneVoiceRow(row: AudioCloneVoice): PipelineVoiceDto {
    const abs = isAbsolute(row.filePath) ? row.filePath : resolve(process.cwd(), row.filePath);
    const sizeOnDisk = existsSync(abs) ? statSync(abs).size : row.fileSize;
    const voiceDir = row.userId
      ? join(this.resolvePipelineVoiceDir(), row.userId).replace(/\\/g, "/")
      : this.resolvePipelineVoiceDir().replace(/\\/g, "/");
    return {
      id: row.id,
      displayName: row.displayName,
      fileName: row.fileName,
      refText: row.refText,
      omnivoiceLanguage: row.omnivoiceLanguage,
      size: sizeOnDisk,
      updatedAt: row.updatedAt.toISOString(),
      voiceDir,
      absolutePath: abs.replace(/\\/g, "/"),
      verified: existsSync(abs) && sizeOnDisk > 0,
    };
  }

  async listPipelineVoices(userId: string): Promise<PipelineVoiceDto[]> {
    const ownerId = await this.requireCloneVoiceOwner(userId);
    const rows = await this.cloneVoiceRepository.find({
      where: { userId: ownerId },
      order: { updatedAt: "DESC" },
    });
    return rows.map((row) => this.mapCloneVoiceRow(row));
  }

  async savePipelineVoiceUpload(input: {
    originalName: string;
    voiceName?: string;
    refText: string;
    omnivoiceLanguage: string;
    buffer: Buffer;
    userId: string;
  }): Promise<PipelineVoiceDto> {
    const ownerId = await this.requireCloneVoiceOwner(input.userId);
    const refText = String(input.refText || "").trim();
    if (!refText) {
      throw new BadRequestException("refText is required");
    }
    let omnivoiceLanguage: string;
    try {
      omnivoiceLanguage = resolveOmnivoiceLanguageValue(input.omnivoiceLanguage);
    } catch (err) {
      throw new BadRequestException(err instanceof Error ? err.message : "Invalid omnivoice language");
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

    const dir = this.ensurePipelineVoiceDir(ownerId);
    const abs = join(dir, fileName);
    try {
      writeFileSync(abs, input.buffer);
      this.writePipelineVoiceRefText(fileName, refText, ownerId);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? String((err as NodeJS.ErrnoException).code) : "";
      if (code === "EACCES" || code === "EPERM") {
        throw new BadRequestException(
          `Cannot write to ${dir.replace(/\\/g, "/")}. Grant write permission to the Nest process user, e.g. chown -R www-data tools/video-pipeline/voice`,
        );
      }
      throw err;
    }

    const verified = await this.assertPipelineVoiceReady(fileName, refText, ownerId);
    const stats = statSync(abs);
    const relativePath = join("tools", "video-pipeline", "voice", ownerId, fileName).replace(
      /\\/g,
      "/",
    );
    const mimeType =
      ext === ".mp3" ? "audio/mpeg" : ext === ".m4a" ? "audio/mp4" : ext === ".wav" ? "audio/wav" : null;

    const existing = await this.cloneVoiceRepository.findOne({
      where: { fileName, userId: ownerId },
    });
    const row = existing
      ? Object.assign(existing, {
          displayName,
          refText,
          omnivoiceLanguage,
          filePath: relativePath,
          fileSize: stats.size,
          mimeType,
          userId: ownerId,
        })
      : this.cloneVoiceRepository.create({
          displayName,
          fileName,
          refText,
          omnivoiceLanguage,
          filePath: relativePath,
          fileSize: stats.size,
          mimeType,
          userId: ownerId,
        });

    const saved = await this.cloneVoiceRepository.save(row);
    return {
      ...this.mapCloneVoiceRow(saved),
      voiceDir: verified.voiceDir.replace(/\\/g, "/"),
      absolutePath: verified.absolutePath.replace(/\\/g, "/"),
      verified: true,
    };
  }

  async deletePipelineVoice(
    fileName: string,
    userId: string,
  ): Promise<{ deleted: true; fileName: string }> {
    const ownerId = await this.requireCloneVoiceOwner(userId);
    const safeName = basename(String(fileName || "").trim());
    if (!safeName) {
      throw new BadRequestException("fileName is required");
    }

    const row = await this.cloneVoiceRepository.findOne({
      where: { fileName: safeName, userId: ownerId },
    });
    if (!row) {
      throw new NotFoundException(`Clone voice not found: ${safeName}`);
    }

    const abs = row.filePath
      ? isAbsolute(row.filePath)
        ? row.filePath
        : resolve(process.cwd(), row.filePath)
      : join(this.resolvePipelineVoiceDir(), ownerId, safeName);

    if (existsSync(abs)) {
      try {
        await unlink(abs);
      } catch (err) {
        this.logger.warn(
          `Could not delete pipeline voice file ${safeName}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const sidecar = this.pipelineVoiceRefSidecarPath(safeName, ownerId);
    if (existsSync(sidecar)) {
      try {
        await unlink(sidecar);
      } catch (err) {
        this.logger.warn(
          `Could not delete ref sidecar for pipeline voice ${safeName}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await this.cloneVoiceRepository.delete({ id: row.id });

    await this.logsService.createLog({
      userId: row.userId,
      action: "audio.clone_voice.deleted",
      payload: { fileName: safeName, displayName: row.displayName },
    });

    return { deleted: true, fileName: safeName };
  }

  private async resolveCloneReference(
    dto: CreateAudioJobDto,
  ): Promise<{ refAudioPath: string; refText: string }> {
    if (dto.pipelineRefWav?.trim()) {
      const verified = await this.assertPipelineVoiceReady(
        dto.pipelineRefWav.trim(),
        dto.cloneRefText?.trim(),
        dto.userId,
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
    let omnivoiceLanguage: string | undefined;

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
      if (dto.pipelineRefWav?.trim()) {
        omnivoiceLanguage = await this.resolvePipelineVoiceLanguage(
          dto.pipelineRefWav.trim(),
          dto.userId,
        );
      }
    }

    const estimatedCost = dto.estimatedCost ?? 0;

    const displayName = text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;
    const ttsEngine = this.resolveTtsEngine(dto.ttsEngine);

    const history = this.audioRepository.create({
      userId: dto.userId,
      inputText: text,
      displayName,
      voiceMode: dto.voiceMode,
      voiceId,
      engineConfig: {
        ttsEngine,
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
        ...(omnivoiceLanguage ? { omnivoiceLanguage } : {}),
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

  async enqueueFromSrt(dto: CreateAudioFromSrtDto): Promise<AudioHistory> {
    const srtText = dto.srtText.trim();
    if (!srtText) {
      throw new BadRequestException("srtText is required");
    }
    if (srtText.length > 500_000) {
      throw new BadRequestException("srtText exceeds 500000 characters");
    }
    if (!/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/.test(srtText)) {
      throw new BadRequestException("srtText does not look like a valid SRT timeline");
    }

    const user = await this.userRepository.findOne({ where: { id: dto.userId } });
    if (!user) {
      throw new BadRequestException("User not found");
    }

    let refAudioPath: string;
    let refText: string;
    let voiceId: string | null = null;
    let omnivoiceLanguage: string | undefined;

    if (dto.voiceMode === "preset") {
      if (!dto.voiceId) {
        throw new BadRequestException("voiceId is required for preset mode");
      }
      const preset = this.getPresetVoice(dto.voiceId);
      voiceId = preset.id;
      refAudioPath = this.resolvePresetRefAudioPath(preset.refWav);
      refText = preset.refText;
    } else {
      const resolved = await this.resolveCloneReference({
        userId: dto.userId,
        voiceMode: "clone",
        text: "srt",
        cloneRefWav: dto.cloneRefWav,
        pipelineRefWav: dto.pipelineRefWav,
        cloneRefText: dto.cloneRefText,
      } as CreateAudioJobDto);
      refAudioPath = resolved.refAudioPath;
      refText = resolved.refText;
      if (dto.pipelineRefWav?.trim()) {
        omnivoiceLanguage = await this.resolvePipelineVoiceLanguage(
          dto.pipelineRefWav.trim(),
          dto.userId,
        );
      }
    }

    const cueCount = (srtText.match(/\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/g) ?? []).length;
    const displayName =
      cueCount > 0 ? `SRT timeline (${cueCount} cue)` : "SRT timeline";
    const ttsEngine = this.resolveTtsEngine(dto.ttsEngine);

    const history = this.audioRepository.create({
      userId: dto.userId,
      inputText: srtText.slice(0, 8000),
      displayName,
      voiceMode: dto.voiceMode,
      voiceId,
      engineConfig: {
        jobKind: AUDIO_JOB_KIND_SRT_TIMELINE,
        ttsEngine,
        srtText,
        refAudioPath,
        refText,
        speed: dto.speed ?? 1,
        fitToCue: dto.fitToCue !== false,
        cloneRefWav: dto.cloneRefWav ?? dto.pipelineRefWav ?? null,
        ...(omnivoiceLanguage ? { omnivoiceLanguage } : {}),
      },
      status: QueueJobStatus.PENDING,
      cost: (dto.estimatedCost ?? 0).toFixed(2),
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
      action: "audio.srt_timeline.queued",
      payload: {
        audioHistoryId: saved.id,
        queueJobId: saved.queueJobId,
        voiceMode: saved.voiceMode,
        voiceId: saved.voiceId,
        cueCount,
      },
      ip: user.ip,
    });

    return saved;
  }

  async resolveVideoVoiceReference(
    dto: ExecuteVoiceDto,
  ): Promise<{ refAudioPath: string; refText: string; language: string }> {
    if (dto.voiceMode === "preset") {
      const preset = this.getPresetVoice(dto.voiceId!.trim());
      return {
        refAudioPath: this.resolvePresetRefAudioPath(preset.refWav),
        refText: preset.refText,
        language: resolveOmnivoiceLanguage(preset),
      };
    }
    const verified = await this.assertPipelineVoiceReady(
      dto.pipelineRefWav!.trim(),
      dto.cloneRefText?.trim(),
      dto.userId,
    );
    return {
      refAudioPath: verified.absolutePath,
      refText: verified.refText,
      language: await this.resolvePipelineVoiceLanguage(dto.pipelineRefWav!.trim(), dto.userId),
    };
  }

  /** Resolve reference audio + refText + language for a preset/clone voice request. */
  private async resolveTtsReference(opts: {
    userId: string;
    voiceMode: "preset" | "clone";
    voiceId?: string | null;
    pipelineRefWav?: string | null;
    cloneRefText?: string | null;
    language?: string | null;
  }): Promise<{ refAudioPath: string; refText: string; language: string }> {
    if (opts.voiceMode === "preset") {
      if (!opts.voiceId?.trim()) {
        throw new BadRequestException("voiceId is required for preset mode");
      }
      const preset = this.getPresetVoice(opts.voiceId.trim());
      return {
        refAudioPath: this.resolvePresetRefAudioPath(preset.refWav),
        refText: preset.refText,
        language: resolveOmnivoiceLanguage(preset),
      };
    }

    if (!opts.pipelineRefWav?.trim()) {
      throw new BadRequestException("pipelineRefWav is required for clone mode");
    }
    const verified = await this.assertPipelineVoiceReady(
      opts.pipelineRefWav.trim(),
      opts.cloneRefText?.trim(),
      opts.userId,
    );
    const language = opts.language?.trim()
      ? resolveOmnivoiceLanguageValue(opts.language)
      : verified.omnivoiceLanguage?.trim()
        ? resolveOmnivoiceLanguageValue(verified.omnivoiceLanguage)
        : await this.resolvePipelineVoiceLanguage(opts.pipelineRefWav.trim(), opts.userId);
    return { refAudioPath: verified.absolutePath, refText: verified.refText, language };
  }

  /**
   * Synchronously generate a single TTS WAV for another module (e.g. ShortVideo).
   * Resolves reference audio + language per voice mode, then runs OmniVoice/VoxCPM2.
   * Returns the absolute path of the produced WAV.
   */
  async generateVoiceToFile(opts: {
    userId: string;
    text: string;
    outWav: string;
    ttsEngine?: string | null;
    voiceMode: "preset" | "clone";
    voiceId?: string | null;
    pipelineRefWav?: string | null;
    cloneRefText?: string | null;
    language?: string | null;
    speed?: number | null;
  }): Promise<string> {
    const text = String(opts.text ?? "").trim();
    if (!text) {
      throw new BadRequestException("text is required for voice generation");
    }
    if (text.length > AUDIO_MAX_TEXT_CHARS) {
      throw new BadRequestException(`text exceeds ${AUDIO_MAX_TEXT_CHARS} characters`);
    }

    const { refAudioPath, refText, language } = await this.resolveTtsReference(opts);

    const rawSpeed = Number(opts.speed ?? 1);
    const playbackSpeed = Number.isFinite(rawSpeed) ? Math.min(2, Math.max(0.5, rawSpeed)) : 1;

    await this.spawnOmnivoiceTts({
      text,
      outWav: opts.outWav,
      refAudio: refAudioPath,
      refText,
      language,
      playbackSpeed,
      ttsEngine: this.resolveTtsEngine(opts.ttsEngine),
    });

    return opts.outWav;
  }

  /**
   * Generate one voice WAV by synthesizing each caption (single model load) and
   * return the real per-caption timeline so callers can align subtitles/scenes
   * to the produced speech.
   */
  async generateVoiceTimeline(opts: {
    userId: string;
    captions: string[];
    outWav: string;
    ttsEngine?: string | null;
    voiceMode: "preset" | "clone";
    voiceId?: string | null;
    pipelineRefWav?: string | null;
    cloneRefText?: string | null;
    language?: string | null;
    speed?: number | null;
    gapSec?: number | null;
  }): Promise<{ outWav: string; totalSec: number; segments: { start: number; end: number }[] }> {
    const captions = (opts.captions ?? []).map((c) => String(c ?? "").trim()).filter(Boolean);
    if (captions.length === 0) {
      throw new BadRequestException("captions are required for voice timeline generation");
    }

    const { refAudioPath, refText, language } = await this.resolveTtsReference(opts);
    const outWav = isAbsolute(opts.outWav) ? opts.outWav : resolve(process.cwd(), opts.outWav);

    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const scriptPath = resolve(scriptDir, "shortvideo_voice_timeline.py");
    if (!existsSync(scriptPath)) {
      throw new Error(`Missing script: ${scriptPath}`);
    }

    const engine = this.resolveTtsEngine(opts.ttsEngine);
    const timeoutMs = Math.max(this.resolveCmdTimeoutMs(), 30 * 60_000);
    const seed = engine === "voxcpm2" ? this.resolveVoxcpm2Seed() : this.resolveOmnivoiceSeed();
    const rawSpeed = Number(opts.speed ?? 1);
    const playbackSpeed = Number.isFinite(rawSpeed) ? Math.min(2, Math.max(0.5, rawSpeed)) : 1;

    const base = {
      captions,
      out_wav: outWav,
      ref_audio: refAudioPath,
      ref_text: refText,
      language,
      playback_speed: playbackSpeed,
      ...(opts.gapSec != null ? { gap_sec: opts.gapSec } : {}),
      ...(seed != null ? { seed } : {}),
    };

    const payload =
      engine === "voxcpm2"
        ? {
            engine: "voxcpm2",
            ...base,
            model_id: (process.env.VOXCPM2_MODEL_ID ?? "openbmb/VoxCPM2").trim(),
            cfg_value: Number(process.env.VOXCPM2_CFG_VALUE ?? 2),
            inference_timesteps: Number(process.env.VOXCPM2_INFERENCE_TIMESTEPS ?? 10),
          }
        : {
            engine: "omnivoice",
            ...base,
            model_id: (process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim(),
            device_map: (process.env.OMNIVOICE_DEVICE_MAP ?? "").trim() || "cuda:0",
            dtype_str: (process.env.OMNIVOICE_DTYPE ?? "float16").trim(),
            num_step: Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
            guidance_scale: Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
          };

    const pythonBin = this.resolvePythonBin();
    let stdout = "";

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [scriptPath], {
        cwd: scriptDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`Voice timeline TTS timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
        if (stdout.length > AudioService.MAX_LOG_BUFFER) {
          stdout = stdout.slice(-AudioService.MAX_LOG_BUFFER);
        }
      });
      child.stderr?.on("data", (buf: Buffer) => {
        stderr += buf.toString("utf8");
        if (stderr.length > AudioService.MAX_LOG_BUFFER) {
          stderr = stderr.slice(-AudioService.MAX_LOG_BUFFER);
        }
      });
      child.on("error", (err) => {
        clearTimeout(timeoutHandle);
        rejectPromise(err);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          const suffix = signal ? ` (signal ${signal})` : "";
          rejectPromise(new Error(stderr.trim() || `Voice timeline exited with code ${code}${suffix}`));
          return;
        }
        resolvePromise();
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    if (!existsSync(outWav)) {
      throw new Error(`Voice timeline did not produce output: ${outWav}`);
    }

    let meta: Record<string, unknown> = {};
    try {
      const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "{}";
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed && typeof parsed === "object") meta = parsed;
    } catch {
      meta = {};
    }

    const rawSegments = Array.isArray(meta.segments) ? meta.segments : [];
    const segments = rawSegments.map((s) => {
      const seg = (s ?? {}) as Record<string, unknown>;
      return { start: Number(seg.start) || 0, end: Number(seg.end) || 0 };
    });
    const totalSec =
      Number(meta.total_sec) || (segments.length ? segments[segments.length - 1].end : 0);

    return { outWav, totalSec, segments };
  }

  async createVideoVoiceHistory(input: {
    id: string;
    userId: string;
    voiceMode: "preset" | "clone";
    voiceId: string | null;
    text: string;
    refAudioPath: string;
    refText: string;
  }): Promise<AudioHistory> {
    const displayName = input.text.length > 80 ? `${input.text.slice(0, 77).trim()}...` : input.text;
    const history = this.audioRepository.create({
      id: input.id,
      userId: input.userId,
      inputText: input.text,
      displayName,
      voiceMode: input.voiceMode,
      voiceId: input.voiceId,
      engineConfig: {
        refAudioPath: input.refAudioPath,
        refText: input.refText,
        source: AUDIO_HISTORY_SOURCE_VIDEO_VOICE,
      },
      status: QueueJobStatus.RUNNING,
      cost: "0",
      queueJobId: null,
      resultPath: null,
      resultFileName: null,
      errorMessage: null,
    });
    return this.audioRepository.save(history);
  }

  async completeVideoVoiceHistory(audioHistoryId: string, resultPath: string): Promise<void> {
    await this.audioRepository.update(
      { id: audioHistoryId },
      {
        status: QueueJobStatus.COMPLETED,
        resultPath: resultPath.replaceAll("\\", "/"),
        resultFileName: basename(resultPath),
        errorMessage: null,
      },
    );
  }

  async failVideoVoiceHistory(audioHistoryId: string, errorMessage: string): Promise<void> {
    await this.processFailed(audioHistoryId, errorMessage);
  }

  resolveHistoryListSourceType(raw?: string | null): AudioHistoryListSourceType {
    const key = String(raw ?? "studio").trim().toLowerCase();
    return key === "auto" ? "auto" : "studio";
  }

  resolveHistorySourceType(row: AudioHistory): AudioHistoryListSourceType {
    const source = String((row.engineConfig as Record<string, unknown> | null)?.source ?? "").trim();
    return source === AUDIO_HISTORY_SOURCE_VIDEO_VOICE ? "auto" : "studio";
  }

  private applyHistorySourceFilter(
    qb: SelectQueryBuilder<AudioHistory>,
    sourceType: AudioHistoryListSourceType,
  ): SelectQueryBuilder<AudioHistory> {
    if (sourceType === "auto") {
      return qb.andWhere("audio.engine_config->>'source' = :videoSource", {
        videoSource: AUDIO_HISTORY_SOURCE_VIDEO_VOICE,
      });
    }
    return qb.andWhere(
      "(audio.engine_config IS NULL OR audio.engine_config->>'source' IS NULL OR audio.engine_config->>'source' != :videoSource)",
      { videoSource: AUDIO_HISTORY_SOURCE_VIDEO_VOICE },
    );
  }

  private buildHistoryQuery(
    userId: string,
    sourceType: AudioHistoryListSourceType,
  ): SelectQueryBuilder<AudioHistory> {
    const qb = this.audioRepository.createQueryBuilder("audio").where("audio.user_id = :userId", { userId });
    return this.applyHistorySourceFilter(qb, sourceType);
  }

  async getHistory(
    userId: string,
    options?: { page?: number; limit?: number; sourceType?: string },
  ): Promise<{ items: AudioHistory[]; total: number; page: number; limit: number; hasMore: boolean }> {
    const page = Math.max(1, Number(options?.page ?? 1) || 1);
    const limit = Math.min(50, Math.max(1, Number(options?.limit ?? 20) || 20));
    const sourceType = this.resolveHistoryListSourceType(options?.sourceType);
    const [items, total] = await this.buildHistoryQuery(userId, sourceType)
      .orderBy("audio.created_at", "DESC")
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();
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

  async deleteAllHistory(
    userId: string,
    options?: { sourceType?: string },
  ): Promise<{ deleted: number }> {
    const sourceType = this.resolveHistoryListSourceType(options?.sourceType);
    const rows = await this.buildHistoryQuery(userId, sourceType).getMany();
    for (const row of rows) {
      await this.deleteHistory(userId, row.id);
    }
    return { deleted: rows.length };
  }

  mapHistoryForClient(row: AudioHistory) {
    const config = (row.engineConfig ?? {}) as Record<string, unknown>;
    const isSrt = String(config.jobKind ?? "") === AUDIO_JOB_KIND_SRT_TIMELINE;
    return {
      id: row.id,
      name: row.displayName,
      detail: isSrt
        ? row.voiceMode === "preset"
          ? "SRT · Giọng mẫu"
          : "SRT · Clone"
        : row.voiceMode === "preset"
          ? "Giọng mẫu"
          : "Clone",
      completed: row.status === QueueJobStatus.COMPLETED,
      status: row.status,
      voiceMode: row.voiceMode,
      voiceId: row.voiceId,
      sourceType: this.resolveHistorySourceType(row),
      jobKind: isSrt ? AUDIO_JOB_KIND_SRT_TIMELINE : "text",
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

    const config =
      history.engineConfig && typeof history.engineConfig === "object"
        ? (history.engineConfig as Record<string, unknown>)
        : {};
    const isSrt = String(config.jobKind ?? "") === AUDIO_JOB_KIND_SRT_TIMELINE;
    await this.notificationsService.pushSuccess(
      user.id,
      isSrt ? "Audio từ SRT hoàn tất" : "Tạo audio hoàn tất",
      isSrt
        ? `Audio timeline SRT "${history.displayName}" đã sẵn sàng.`
        : `Audio "${history.displayName}" đã sẵn sàng.`,
    );
  }

  async processFailed(audioHistoryId: string, errorMessage: string): Promise<void> {
    this.logger.error(`Audio failed: historyId=${audioHistoryId} error=${errorMessage}`);
    const history = await this.audioRepository.findOne({ where: { id: audioHistoryId } });
    await this.audioRepository.update(
      { id: audioHistoryId },
      { status: QueueJobStatus.FAILED, errorMessage },
    );
    if (history?.userId) {
      const config =
        history.engineConfig && typeof history.engineConfig === "object"
          ? (history.engineConfig as Record<string, unknown>)
          : {};
      const isSrt = String(config.jobKind ?? "") === AUDIO_JOB_KIND_SRT_TIMELINE;
      await this.notificationsService.pushError(
        history.userId,
        isSrt ? "Audio từ SRT lỗi" : "Tạo audio lỗi",
        errorMessage,
        isSrt
          ? "Không tạo được audio từ SRT. Kiểm tra nội dung SRT / giọng và thử lại."
          : "Không tạo được audio. Kiểm tra văn bản / giọng và thử lại.",
      );
    }
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
    let language: string;
    if (preset) {
      language = resolveOmnivoiceLanguage(preset);
    } else {
      const fromConfig = String(config.omnivoiceLanguage ?? "").trim();
      if (fromConfig) {
        language = resolveOmnivoiceLanguageValue(fromConfig);
      } else {
        const refWav = String(config.cloneRefWav ?? config.pipelineRefWav ?? "").trim();
        if (!refWav) {
          throw new Error("engine_config missing clone voice reference for language");
        }
        language = await this.resolvePipelineVoiceLanguage(refWav, history.userId);
      }
    }

    const rawSpeed = Number(config.speed ?? 1);
    const playbackSpeed = Number.isFinite(rawSpeed) ? Math.min(2, Math.max(0.5, rawSpeed)) : 1;
    const ttsEngine = this.resolveTtsEngine(
      typeof config.ttsEngine === "string" ? config.ttsEngine : undefined,
    );

    if (String(config.jobKind ?? "") === AUDIO_JOB_KIND_SRT_TIMELINE) {
      const srtText = String(config.srtText ?? history.inputText ?? "").trim();
      if (!srtText) {
        throw new Error("engine_config.srtText is missing");
      }
      const fitToCue = config.fitToCue !== false;
      await this.spawnSrtTimelineTts(
        {
          srtText,
          outWav: outPath,
          refAudio: refAudioPath,
          refText,
          language,
          playbackSpeed,
          fitToCue,
          ttsEngine,
        },
        history.id,
      );
      return outPath.replaceAll("\\", "/");
    }

    const pauseSettings =
      config.pauseSettings && typeof config.pauseSettings === "object"
        ? (config.pauseSettings as Record<string, number>)
        : undefined;
    await this.spawnOmnivoiceTts(
      {
        text: history.inputText,
        outWav: outPath,
        refAudio: refAudioPath,
        refText,
        language,
        pauseSettings,
        playbackSpeed,
        ttsEngine,
      },
      history.id,
    );

    return outPath.replaceAll("\\", "/");
  }
}
