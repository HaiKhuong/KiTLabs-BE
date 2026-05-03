import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { spawn } from "child_process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "path";

import { TRANSLATE_QUEUE_NAME, TranslateService } from "./translate.service";
import { TranslateGateway } from "./translate.gateway";

const MAX_PYTHON_LOG_BUFFER = 10 * 1024 * 1024;
const OPTION_MAPPINGS: Array<{
  cliFlag: string;
  keys: string[];
  allowedTypes: Array<"string" | "number">;
}> = [
    { cliFlag: "--subtitle-font", keys: ["subtitleFont", "subtitle_font"], allowedTypes: ["string"] },
    {
      cliFlag: "--subtitle-fontsize",
      keys: ["subtitleFontsize", "subtitle_fontsize"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-primary-colour",
      keys: ["subtitlePrimaryColor", "subtitle_primary_colour"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--subtitle-outline-colour",
      keys: ["subtitleOutlineColor", "subtitle_outline_colour"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--subtitle-outline",
      keys: ["subtitleOutline", "subtitle_outline"],
      allowedTypes: ["number", "string"],
    },
    { cliFlag: "--subtitle-shadow", keys: ["subtitleShadow", "subtitle_shadow"], allowedTypes: ["number", "string"] },
    {
      cliFlag: "--subtitle-uppercase",
      keys: ["subtitleUppercase", "subtitle_uppercase"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--subtitle-alignment",
      keys: ["subtitleAlignment", "subtitle_alignment"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-margin-v",
      keys: ["subtitleMarginV", "subtitle_margin_v"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-width-ratio",
      keys: ["subtitleBgBlurWidthRatio", "subtitle_bg_blur_width_ratio"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-height",
      keys: ["subtitleBgBlurHeight", "subtitle_bg_blur_height"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-bottom-offset",
      keys: ["subtitleBgBlurBottomOffset", "subtitle_bg_blur_bottom_offset"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-luma-radius",
      keys: ["subtitleBgBlurLumaRadius", "subtitle_bg_blur_luma_radius"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-luma-power",
      keys: ["subtitleBgBlurLumaPower", "subtitle_bg_blur_luma_power"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-chroma-radius",
      keys: ["subtitleBgBlurChromaRadius", "subtitle_bg_blur_chroma_radius"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--subtitle-bg-blur-chroma-power",
      keys: ["subtitleBgBlurChromaPower", "subtitle_bg_blur_chroma_power"],
      allowedTypes: ["number", "string"],
    },
    { cliFlag: "--logo-file", keys: ["logoFile", "logo_file"], allowedTypes: ["string"] },
    { cliFlag: "--logo-width", keys: ["logoWidth", "logo_width"], allowedTypes: ["number", "string"] },
    { cliFlag: "--logo-margin-x", keys: ["logoMarginX", "logo_margin_x"], allowedTypes: ["number", "string"] },
    { cliFlag: "--logo-margin-y", keys: ["logoMarginY", "logo_margin_y"], allowedTypes: ["number", "string"] },
    { cliFlag: "--logo-opacity", keys: ["logoOpacity", "logo_opacity"], allowedTypes: ["number", "string"] },
    { cliFlag: "--logo-enabled", keys: ["logoEnabled", "logo_enabled"], allowedTypes: ["string"] },
    { cliFlag: "--original-volume", keys: ["originalVolume", "original_volume"], allowedTypes: ["number", "string"] },
    {
      cliFlag: "--narration-volume",
      keys: ["narrationVolume", "narration_volume"],
      allowedTypes: ["number", "string"],
    },
    { cliFlag: "--speed-video", keys: ["speedVideo", "speed_video"], allowedTypes: ["number", "string"] },
    { cliFlag: "--edge-tts-voice", keys: ["edgeTtsVoice", "edge_tts_voice"], allowedTypes: ["string"] },
    { cliFlag: "--edge-tts-rate", keys: ["edgeTtsRate", "edge_tts_rate"], allowedTypes: ["string"] },
    { cliFlag: "--edge-tts-volume", keys: ["edgeTtsVolume", "edge_tts_volume"], allowedTypes: ["string"] },
    { cliFlag: "--edge-tts-pitch", keys: ["edgeTtsPitch", "edge_tts_pitch"], allowedTypes: ["string"] },
    { cliFlag: "--auto-speed", keys: ["autoSpeed", "auto_speed"], allowedTypes: ["string"] },
    {
      cliFlag: "--step3-auto-rate-trigger-cps",
      keys: ["step3AutoRateTriggerCharsPerSec", "step3_auto_rate_trigger_chars_per_sec"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--step3-auto-rate-bonus-percent",
      keys: ["step3AutoRateBonusPercent", "step3_auto_rate_bonus_percent"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--step3-tts-api-timeout-sec",
      keys: ["step3TtsApiTimeoutSec", "step3_tts_api_timeout_sec"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--step3-tts-max-retry-action",
      keys: ["step3TtsMaxRetryAction", "step3_tts_max_retry_action"],
      allowedTypes: ["string"],
    },
    { cliFlag: "--translation-context", keys: ["translationContext", "translation_context"], allowedTypes: ["string"] },
    { cliFlag: "--mode", keys: ["mode", "mode"], allowedTypes: ["string"] },
    {
      cliFlag: "--step1-subtitle-source",
      keys: ["step1SubtitleSource", "step1_subtitle_source"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--easyocr-crop-band-lo",
      keys: ["easyOcrCropBandLo", "easy_ocr_crop_band_lo"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--easyocr-crop-band-hi",
      keys: ["easyOcrCropBandHi", "easy_ocr_crop_band_hi"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--easyocr-crop-auto",
      keys: ["easyOcrCropAuto", "easy_ocr_crop_auto"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--easyocr-crop-probe-debug",
      keys: ["easyOcrCropProbeDebug", "easy_ocr_crop_probe_debug"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--easyocr-crop-probe-export",
      keys: ["easyOcrCropProbeExport", "easy_ocr_crop_probe_export"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--easyocr-crop-probe-export-on-fallback",
      keys: ["easyOcrCropProbeExportOnFallback", "easy_ocr_crop_probe_export_on_fallback"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--easyocr-min-duration-ms",
      keys: ["easyOcrMinDurationMs", "easy_ocr_min_duration_ms"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--easyocr-cleanup-debug-after-step7",
      keys: [
        "easyOcrCleanupDebugAfterStep7",
        "easy_ocr_cleanup_debug_after_step7",
      ],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--step6-hflip",
      keys: ["step6Hflip", "step6_hflip", "enableFlip", "enable_flip"],
      allowedTypes: ["string"],
    },
    {
      cliFlag: "--step6-zoom-percent",
      keys: ["step6ZoomPercent", "step6_zoom_percent"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--step6-eq-saturation",
      keys: ["step6EqSaturation", "step6_eq_saturation"],
      allowedTypes: ["number", "string"],
    },
    {
      cliFlag: "--step6-eq-contrast",
      keys: ["step6EqContrast", "step6_eq_contrast"],
      allowedTypes: ["number", "string"],
    },
  ];

@Processor(TRANSLATE_QUEUE_NAME)
export class TranslateProcessor extends WorkerHost {
  private readonly logger = new Logger(TranslateProcessor.name);

  constructor(
    private readonly translateService: TranslateService,
    private readonly translateGateway: TranslateGateway,
  ) {
    super();
  }

  async process(job: Job<{ translateHistoryId: string }>): Promise<void> {
    const { translateHistoryId } = job.data;

    await this.translateService.processStarted(translateHistoryId);
    this.logger.log(`Translate job ${job.id} → ${translateHistoryId}`);

    try {
      const history = await this.translateService.getById(translateHistoryId);
      if (!history) {
        throw new Error(`Translate history ${translateHistoryId} not found`);
      }

      const resultPath = await this.executePythonTranslate({
        stepNbr: history.stepNbr,
        engineConfig: history.engineConfig,
        translateHistoryId,
      });

      await this.translateService.processCompleted(translateHistoryId, resultPath);
      const completedHistory = await this.translateService.getById(translateHistoryId);
      this.translateGateway.notifyUser(completedHistory?.userId ?? "all", "translate.completed", {
        translateHistoryId,
        resultPath,
        stepNbr: history.stepNbr,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown translation failure";
      const maxAttempts = job.opts.attempts != null ? Number(job.opts.attempts) : 1;
      const attemptsMade = job.attemptsMade != null ? Number(job.attemptsMade) : 0;
      const isUnrecoverable =
        error instanceof UnrecoverableError || (error instanceof Error && error.name === "UnrecoverableError");
      const willRetry = !isUnrecoverable && attemptsMade + 1 < maxAttempts;
      if (willRetry) {
        this.logger.warn(
          `Translate job ${job.id} failed (attempt ${attemptsMade + 1}/${maxAttempts}), will retry: ${message}`,
        );
        throw error;
      }
      await this.translateService.processFailed(translateHistoryId, message);
      const failedHistory = await this.translateService.getById(translateHistoryId);
      this.translateGateway.notifyUser(failedHistory?.userId ?? "all", "translate.failed", {
        translateHistoryId,
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }

  private async executePythonTranslate(input: {
    stepNbr: number[];
    engineConfig: Record<string, unknown> | null;
    translateHistoryId: string;
  }): Promise<string> {
    const pythonBin = process.env.TRANSLATE_PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
    const scriptPath = process.env.TRANSLATE_PYTHON_SCRIPT ?? "tools/video-pipeline/auto_vietsub_pro.py";
    const timeoutMs = Number(process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600000);
    const absScriptPath = isAbsolute(scriptPath) ? scriptPath : resolve(scriptPath);
    const scriptDir = dirname(absScriptPath);
    const engineConfig = input.engineConfig ?? {};

    const videoInputPath = this.resolveVideoInputPath(engineConfig);
    const workName = basename(videoInputPath, extname(videoInputPath));

    const args = [absScriptPath, videoInputPath];
    this.appendStepRangeArg(args, input.stepNbr);
    this.appendOptionalCliOptions(args, engineConfig);

    const scriptBase = basename(absScriptPath);
    const videoBase = basename(videoInputPath);
    this.logger.log(
      `Translate python: ${scriptBase} video=${videoBase} steps=[${input.stepNbr.join(",")}]`,
    );
    const startedAt = Date.now();
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(pythonBin, args, {
          cwd: scriptDir,
          windowsHide: true,
          env: {
            ...process.env,
            HOME: "/home/haikhuong",
            XDG_CACHE_HOME: "/home/haikhuong/.cache",
            // Force Python to flush stdout on every write (line-buffered).
            // Without this, print() inside Python is block-buffered when piped,
            // so logs only appear after the buffer fills or the process exits.
            PYTHONUNBUFFERED: "1",
            PYTHONIOENCODING: "utf-8",
          },
        });

        this.logger.log(`Python pid=${child.pid ?? "?"}`);

        let stdout = "";
        let stderr = "";
        let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
          this.logger.error(`Python process timed out after ${timeoutMs}ms, killing process...`);
          child.kill("SIGTERM");
        }, timeoutMs);

        const appendChunk = (target: "stdout" | "stderr", chunk: string) => {
          if (target === "stdout") {
            stdout += chunk;
            if (stdout.length > MAX_PYTHON_LOG_BUFFER) {
              stdout = stdout.slice(stdout.length - MAX_PYTHON_LOG_BUFFER);
            }
          } else {
            stderr += chunk;
            if (stderr.length > MAX_PYTHON_LOG_BUFFER) {
              stderr = stderr.slice(stderr.length - MAX_PYTHON_LOG_BUFFER);
            }
          }
        };

        const handleRuntimeStatus = (chunk: string) => {
          const matches = [
            ...chunk.matchAll(/DB_STATUS\|step=(\d+)\|state=(running|completed|failed)\|message=([^\r\n]*)/g),
          ];
          for (const matched of matches) {
            const step = Number(matched[1]);
            const state = matched[2] as "running" | "completed" | "failed";
            const message = (matched[3] ?? "").trim();
            void this.translateService
              .processRuntimeStatus(input.translateHistoryId, { step, state, message })
              .catch((err) => this.logger.warn(`Failed to persist runtime status: ${String(err)}`));
          }
        };

        const echoPythonChunk = (chunk: string, level: "log" | "warn") => {
          const clipped = this.clipPythonStreamForNestLog(chunk);
          if (clipped === null) {
            return;
          }
          if (level === "warn") {
            this.logger.warn(`[py] ${clipped}`);
          } else {
            this.logger.log(`[py] ${clipped}`);
          }
        };

        child.stdout?.on("data", (data: Buffer) => {
          const message = data.toString();
          appendChunk("stdout", message);
          handleRuntimeStatus(message);
          echoPythonChunk(message, "log");
        });

        child.stderr?.on("data", (data: Buffer) => {
          const message = data.toString();
          appendChunk("stderr", message);
          handleRuntimeStatus(message);
          echoPythonChunk(message, "warn");
        });

        child.on("error", (error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }
          rejectPromise(error);
        });

        child.on("close", (code, signal) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
            timeoutHandle = null;
          }

          const elapsedMs = Date.now() - startedAt;
          this.logger.log(`Python done code=${code ?? "?"} ${elapsedMs}ms`);

          if (code !== 0) {
            const lastStatus = this.extractLatestRuntimeStatus(stdout) ?? this.extractLatestRuntimeStatus(stderr);
            const statusPart = lastStatus
              ? ` (last step=${lastStatus.step}, state=${lastStatus.state}${lastStatus.message ? `, message=${lastStatus.message}` : ""})`
              : "";
            rejectPromise(
              new Error(
                `Python command failed with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}${statusPart}`,
              ),
            );
            return;
          }

          resolvePromise({ stdout, stderr });
        });
      },
    );

    const outputPathFromLogs = this.extractDonePath(stdout) ?? this.extractDonePath(stderr);
    if (outputPathFromLogs) {
      return isAbsolute(outputPathFromLogs) ? outputPathFromLogs : resolve(scriptDir, outputPathFromLogs);
    }

    // Fallback by script's deterministic output convention.
    return this.resolveFallbackOutputPath(scriptDir, workName, input.stepNbr);
  }

  /**
   * Skip echoing chunks that only contain DB_STATUS lines (already persisted).
   * Truncate long lines for shorter Nest / journald output.
   */
  private clipPythonStreamForNestLog(chunk: string): string | null {
    const trimmed = chunk.trimEnd();
    if (!trimmed) {
      return null;
    }
    const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > 0 && lines.every((l) => l.trimStart().startsWith("DB_STATUS|"))) {
      return null;
    }
    const maxLen = 380;
    return trimmed.length > maxLen ? `${trimmed.slice(0, maxLen)}…` : trimmed;
  }

  private resolveVideoInputPath(engineConfig: Record<string, unknown>): string {
    const localPath = this.pickConfigValue(engineConfig, ["localVideoPath", "local_video_path"]);

    if (typeof localPath === "string" && localPath.trim().length > 0) {
      return resolve(localPath.trim()); // 🔥 FIX
    }

    throw new Error("Missing local video path. Provide engineConfig.localVideoPath or engineConfig.local_video_path.");
  }

  private extractDonePath(text: string | undefined): string | null {
    if (!text) {
      return null;
    }
    const matched = text.match(/DONE:\s*(.+)/);
    if (!matched || !matched[1]) {
      return null;
    }
    return matched[1].trim();
  }

  private extractLatestRuntimeStatus(
    text: string | undefined,
  ): { step: number; state: "running" | "completed" | "failed"; message: string } | null {
    if (!text) {
      return null;
    }
    const matches = [...text.matchAll(/DB_STATUS\|step=(\d+)\|state=(running|completed|failed)\|message=([^\r\n]*)/g)];
    if (!matches.length) {
      return null;
    }
    const last = matches[matches.length - 1];
    return {
      step: Number(last[1]),
      state: last[2] as "running" | "completed" | "failed",
      message: (last[3] ?? "").trim(),
    };
  }

  private appendOptionalCliOptions(args: string[], engineConfig: Record<string, unknown>): void {
    for (const mapping of OPTION_MAPPINGS) {
      const rawValue = this.pickConfigValue(engineConfig, mapping.keys);
      if (rawValue === undefined || rawValue === null) {
        continue;
      }

      const rawType = typeof rawValue;
      if (!mapping.allowedTypes.includes(rawType as "string" | "number")) {
        continue;
      }

      const value = String(rawValue).trim();
      if (!value) {
        continue;
      }
      if (value.startsWith("-")) {
        // argparse can treat values like "-20%" as another option token.
        args.push(`${mapping.cliFlag}=${value}`);
      } else {
        args.push(mapping.cliFlag, value);
      }
    }
  }

  private appendStepRangeArg(args: string[], stepNbr: number[]): void {
    if (!Array.isArray(stepNbr) || stepNbr.length === 0) {
      return;
    }
    const uniqueSorted = [...new Set(stepNbr)].sort((a, b) => a - b);
    if (uniqueSorted.length === 1) {
      args.push("--step", String(uniqueSorted[0]));
      return;
    }
    args.push("--step", `${uniqueSorted[0]},${uniqueSorted[uniqueSorted.length - 1]}`);
  }

  private resolveFallbackOutputPath(scriptDir: string, workName: string, stepNbr: number[]): string {
    const workspaceDir = join(scriptDir, "workspace", workName);
    const uniqueSorted = Array.isArray(stepNbr) ? [...new Set(stepNbr)].sort((a, b) => a - b) : [];
    const lastStep = uniqueSorted.length > 0 ? uniqueSorted[uniqueSorted.length - 1] : null;

    if (lastStep === 1) {
      return join(workspaceDir, "subtitles", `${workName}.zh.srt`);
    }

    if (lastStep !== null && lastStep <= 3) {
      return join(workspaceDir, "subtitles", `${workName}.vi.srt`);
    }

    return join(workspaceDir, "videos", `${workName}_vs_tm.mp4`);
  }

  private pickConfigValue(engineConfig: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
      if (key in engineConfig) {
        return engineConfig[key];
      }
    }
    return undefined;
  }
}
