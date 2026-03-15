import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
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
    keys: ["subtitlePrimaryColour", "subtitle_primary_colour"],
    allowedTypes: ["string"],
  },
  {
    cliFlag: "--subtitle-outline-colour",
    keys: ["subtitleOutlineColour", "subtitle_outline_colour"],
    allowedTypes: ["string"],
  },
  {
    cliFlag: "--subtitle-outline",
    keys: ["subtitleOutline", "subtitle_outline"],
    allowedTypes: ["number", "string"],
  },
  { cliFlag: "--subtitle-shadow", keys: ["subtitleShadow", "subtitle_shadow"], allowedTypes: ["number", "string"] },
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
    this.logger.log(`Started translate job ${job.id} for history ${translateHistoryId}`);

    try {
      const history = await this.translateService.getById(translateHistoryId);
      if (!history) {
        throw new Error(`Translate history ${translateHistoryId} not found`);
      }

      const resultPath = await this.executePythonTranslate({
        stepNbr: history.stepNbr,
        engineConfig: history.engineConfig,
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
      await this.translateService.processFailed(translateHistoryId, message);
      const failedHistory = await this.translateService.getById(translateHistoryId);
      this.translateGateway.notifyUser(failedHistory?.userId ?? "all", "translate.failed", {
        translateHistoryId,
        errorMessage: message,
      });
      throw error;
    }
  }

  private async executePythonTranslate(input: {
    stepNbr: number[];
    engineConfig: Record<string, unknown> | null;
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

    this.logger.log(`Executing python command: ${pythonBin} ${args.join(" ")}`);
    const startedAt = Date.now();
    const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
      (resolvePromise, rejectPromise) => {
        const child = spawn(pythonBin, args, {
          cwd: scriptDir,
          windowsHide: true,
        });

        this.logger.log(`Python process started (pid=${child.pid ?? "unknown"})`);

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

        child.stdout?.on("data", (data: Buffer) => {
          const message = data.toString();
          appendChunk("stdout", message);
          this.logger.log(`[python stdout] ${message.trimEnd()}`);
        });

        child.stderr?.on("data", (data: Buffer) => {
          const message = data.toString();
          appendChunk("stderr", message);
          this.logger.warn(`[python stderr] ${message.trimEnd()}`);
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
          this.logger.log(
            `Python process finished (pid=${child.pid ?? "unknown"}, code=${code}, signal=${signal ?? "none"}, elapsed=${elapsedMs}ms)`,
          );

          if (code !== 0) {
            rejectPromise(
              new Error(`Python command failed with code ${code ?? "unknown"}${signal ? ` and signal ${signal}` : ""}`),
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
    return join(scriptDir, "workspace", workName);
  }

  private resolveVideoInputPath(engineConfig: Record<string, unknown>): string {
    const localPath = this.pickConfigValue(engineConfig, ["localVideoPath", "local_video_path"]);
    if (typeof localPath === "string" && localPath.trim().length > 0) {
      return localPath.trim();
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
      args.push(mapping.cliFlag, value);
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

  private pickConfigValue(engineConfig: Record<string, unknown>, keys: string[]): unknown {
    for (const key of keys) {
      if (key in engineConfig) {
        return engineConfig[key];
      }
    }
    return undefined;
  }
}
