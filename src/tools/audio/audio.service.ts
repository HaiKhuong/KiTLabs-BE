import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ChildProcess, spawn } from "child_process";
import { Queue } from "bullmq";
import { existsSync, mkdirSync, statSync } from "fs";
import { basename, isAbsolute, join, resolve } from "path";
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
  VIDEO_PIPELINE_DIR,
  VOICE_SAMPLES_DIR,
  findPresetVoice,
  resolveOmnivoiceLanguage,
  resolvePreviewTtsText,
} from "./audio.constants";
import { AudioHistory } from "./audio-history.entity";
import { CreateAudioJobDto } from "./dto/create-audio-job.dto";

export const AUDIO_QUEUE_NAME = "audio-tts";

@Injectable()
export class AudioService {
  private readonly logger = new Logger(AudioService.name);

  constructor(
    @InjectQueue(AUDIO_QUEUE_NAME)
    private readonly audioQueue: Queue,
    @InjectRepository(AudioHistory, "tool")
    private readonly audioRepository: Repository<AudioHistory>,
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
    "from omnivoice_tts import synthesize_to_wav",
    "synthesize_to_wav(**{k:v for k,v in p.items() if v is not None})",
  ].join(";");

  private static readonly MAX_LOG_BUFFER = 64 * 1024;

  private resolvePythonBin(): string {
    return (
      process.env.AUDIO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private async spawnOmnivoiceTts(opts: {
    text: string;
    outWav: string;
    refAudio: string;
    refText: string;
    language?: string;
    seed?: number;
  }): Promise<string> {
    const refAudio = isAbsolute(opts.refAudio)
      ? opts.refAudio
      : resolve(process.cwd(), opts.refAudio);
    if (!existsSync(refAudio)) {
      throw new Error(`Reference audio not found: ${refAudio}`);
    }

    const outWav = isAbsolute(opts.outWav)
      ? opts.outWav
      : resolve(process.cwd(), opts.outWav);

    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);
    const timeoutMs = Number(
      process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600_000,
    );

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
      ...(opts.seed != null ? { seed: opts.seed } : {}),
    };

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(
        this.resolvePythonBin(),
        ["-c", AudioService.OMNIVOICE_INLINE_PY],
        {
          cwd: scriptDir,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );

      let stderr = "";
      const timeoutHandle = setTimeout(() => {
        child.kill("SIGTERM");
        rejectPromise(new Error(`OmniVoice TTS timed out after ${timeoutMs}ms`));
      }, timeoutMs);

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
      child.on("close", (code) => {
        clearTimeout(timeoutHandle);
        if (code !== 0) {
          rejectPromise(new Error(stderr.trim() || `OmniVoice exited with code ${code}`));
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
    const path = resolve(process.cwd(), VOICE_SAMPLES_DIR, refWav);
    if (!existsSync(path)) {
      throw new BadRequestException(`Preset reference audio missing on server: ${refWav}`);
    }
    return path;
  }

  resolveCloneRefAudioPath(userId: string, fileName: string): string {
    const safeName = basename(fileName);
    const path = resolve(AUDIO_CLONE_UPLOAD_DIR, userId, safeName);
    if (!existsSync(path)) {
      throw new BadRequestException(`Clone reference audio not found: ${safeName}`);
    }
    return path;
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
      if (!dto.cloneRefWav || !dto.cloneRefText?.trim()) {
        throw new BadRequestException("cloneRefWav and cloneRefText are required for clone mode");
      }
      refAudioPath = this.resolveCloneRefAudioPath(dto.userId, dto.cloneRefWav);
      refText = dto.cloneRefText.trim();
    }

    const estimatedCost = dto.estimatedCost ?? 0;

    const displayName =
      text.length > 80 ? `${text.slice(0, 77).trim()}...` : text;

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
        pitch: dto.pitch ?? 0,
        cloneRefWav: dto.cloneRefWav ?? null,
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

  async getHistory(userId: string): Promise<AudioHistory[]> {
    return this.audioRepository.find({
      where: { userId },
      order: { createdAt: "DESC" },
    });
  }

  async getById(id: string): Promise<AudioHistory | null> {
    return this.audioRepository.findOne({ where: { id } });
  }

  mapHistoryForClient(row: AudioHistory) {
    return {
      id: row.id,
      name: row.displayName,
      detail: `${row.voiceMode === "preset" ? "Giọng mẫu" : "Clone"} · ${row.status}`,
      completed: row.status === QueueJobStatus.COMPLETED,
      status: row.status,
      voiceMode: row.voiceMode,
      voiceId: row.voiceId,
      resultFileName: row.resultFileName,
      errorMessage: row.errorMessage,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      downloadUrl:
        row.status === QueueJobStatus.COMPLETED && row.id
          ? `/api/tools/audio/jobs/${row.id}/download`
          : null,
      playUrl:
        row.status === QueueJobStatus.COMPLETED && row.id
          ? `/api/tools/audio/jobs/${row.id}/stream`
          : null,
    };
  }

  async processStarted(audioHistoryId: string): Promise<void> {
    await this.audioRepository.update(
      { id: audioHistoryId },
      { status: QueueJobStatus.RUNNING, errorMessage: null },
    );
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
    await this.audioRepository.update(
      { id: audioHistoryId },
      { status: QueueJobStatus.FAILED, errorMessage },
    );
  }

  resolveResultPath(history: AudioHistory): string {
    if (!history.resultPath) {
      throw new NotFoundException("Audio result not ready");
    }
    const abs = isAbsolute(history.resultPath)
      ? history.resultPath
      : resolve(process.cwd(), history.resultPath);
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
    const language = preset
      ? resolveOmnivoiceLanguage(preset)
      : (process.env.OMNIVOICE_LANGUAGE ?? "vietnamese");

    await this.spawnOmnivoiceTts({
      text: history.inputText,
      outWav: outPath,
      refAudio: refAudioPath,
      refText,
      language,
      seed: process.env.OMNIVOICE_SEED ? Number(process.env.OMNIVOICE_SEED) : undefined,
    });

    return outPath.replaceAll("\\", "/");
  }
}
