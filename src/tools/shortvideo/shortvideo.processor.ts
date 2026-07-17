import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";

import { AudioService } from "../audio/audio.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { SHORTVIDEO_QUEUE_NAME, ShortVideoService } from "./shortvideo.service";
import { ShortVideoHistory } from "./shortvideo-history.entity";

const MAX_LOG_BUFFER = 4 * 1024 * 1024;

@Processor(SHORTVIDEO_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: ShortVideoService.resolveQueueLockDurationMs(),
  stalledInterval: 120_000,
  maxStalledCount: 2,
})
export class ShortVideoProcessor extends WorkerHost {
  private readonly logger = new Logger(ShortVideoProcessor.name);

  constructor(
    private readonly shortVideoService: ShortVideoService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
    private readonly audioService: AudioService,
  ) {
    super();
  }

  private resolvePythonBin(): string {
    return (
      process.env.SHORTVIDEO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveTimeoutMs(): number {
    return Number(process.env.SHORTVIDEO_CMD_TIMEOUT_MS ?? 1_800_000);
  }

  async process(job: Job<{ shortVideoHistoryId: string }>): Promise<void> {
    const id = job.data?.shortVideoHistoryId;
    if (!id) throw new UnrecoverableError("shortVideoHistoryId is required");

    const history = await this.shortVideoService.getById(id);
    if (!history) throw new UnrecoverableError(`ShortVideo history not found: ${id}`);

    const userId = history.userId;
    const nodeId = history.nodeId ?? "";

    try {
      await this.shortVideoService.processStarted(id);

      const workDir = this.shortVideoService.prepareWorkDir(id);
      await this.maybeGenerateVoice(history, workDir);
      const configPath = this.shortVideoService.writeJobConfig(workDir, history);
      const scriptPath = this.shortVideoService.resolveScriptPath();
      if (!existsSync(scriptPath)) {
        throw new UnrecoverableError(`ShortVideo python script not found: ${scriptPath}`);
      }

      const resultPath = await this.spawnPipeline({ id, scriptPath, workDir, configPath });

      await this.shortVideoService.processCompleted(id, resultPath);
      const completed = await this.shortVideoService.getById(id);
      const mapped = completed ? this.shortVideoService.mapForClient(completed) : null;

      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId: id,
        nodeId,
        type: "short_video",
        result: {
          shortVideoHistoryId: id,
          resultPath,
          resultFileName: mapped?.resultFileName ?? null,
          playUrl: mapped?.playUrl ?? null,
          downloadUrl: mapped?.downloadUrl ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.shortVideoService.processFailed(id, message);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId: id,
        nodeId,
        type: "short_video",
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }

  /** When spec.voiceConfig.generate is true, synthesize a voice track from the captions. */
  private async maybeGenerateVoice(history: ShortVideoHistory, workDir: string): Promise<void> {
    const spec = (history.spec ?? {}) as Record<string, unknown>;
    const vc = spec.voiceConfig as Record<string, unknown> | undefined;
    if (!vc || vc.generate !== true) return;

    const captionList = ShortVideoService.buildCaptionList(spec);
    if (captionList.length === 0) {
      throw new UnrecoverableError("Không có caption/subtitle để tạo voice");
    }

    const outWav = join(workDir, "tts_voice.wav");
    const refOpts = {
      userId: history.userId,
      ttsEngine: typeof vc.engine === "string" ? vc.engine : undefined,
      voiceMode: (String(vc.mode ?? "preset") === "clone" ? "clone" : "preset") as
        | "preset"
        | "clone",
      voiceId: typeof vc.voiceId === "string" ? vc.voiceId : undefined,
      pipelineRefWav: typeof vc.pipelineRefWav === "string" ? vc.pipelineRefWav : undefined,
      cloneRefText: typeof vc.refText === "string" ? vc.refText : undefined,
      language: typeof vc.language === "string" ? vc.language : undefined,
      speed: typeof vc.speed === "number" ? vc.speed : undefined,
    };

    const syncTimeline = vc.syncTimeline !== false;

    if (syncTimeline) {
      await this.shortVideoService.updateRuntimeMessage(
        history.id,
        "[STEP 0/6] Generate voice + sync timeline (TTS)",
      );
      const result = await this.audioService.generateVoiceTimeline({
        ...refOpts,
        captions: captionList,
        outWav,
        gapSec: typeof vc.gapSec === "number" ? vc.gapSec : undefined,
      });
      this.applySyncedTimeline(spec, captionList, result);
    } else {
      await this.shortVideoService.updateRuntimeMessage(
        history.id,
        "[STEP 0/6] Generate voice (TTS)",
      );
      await this.audioService.generateVoiceToFile({
        ...refOpts,
        text: captionList.join(" "),
        outWav,
      });
    }

    spec.voice = outWav.replaceAll("\\", "/");
    history.spec = spec;
    await this.shortVideoService.persistSpec(history.id, spec);
  }

  /** Rewrite captions from the generated audio timing and rescale scenes to the new total. */
  private applySyncedTimeline(
    spec: Record<string, unknown>,
    captionList: string[],
    result: { totalSec: number; segments: { start: number; end: number }[] },
  ): void {
    const segments = result.segments ?? [];
    if (segments.length === 0) return;

    spec.captions = segments.map((seg, i) => ({
      time: seg.start,
      text: captionList[i] ?? "",
    }));

    const scenes = Array.isArray(spec.scenes) ? (spec.scenes as Record<string, unknown>[]) : [];
    const oldTotal = scenes.reduce((max, s) => Math.max(max, Number(s?.end) || 0), 0);
    const newTotal = result.totalSec || segments[segments.length - 1].end;
    if (oldTotal > 0 && newTotal > 0 && scenes.length > 0) {
      const factor = newTotal / oldTotal;
      const round3 = (n: number) => Math.round(n * 1000) / 1000;
      spec.scenes = scenes.map((s) => ({
        ...s,
        start: round3((Number(s?.start) || 0) * factor),
        end: round3((Number(s?.end) || 0) * factor),
      }));
    }
  }

  private spawnPipeline(input: {
    id: string;
    scriptPath: string;
    workDir: string;
    configPath: string;
  }): Promise<string> {
    const pythonBin = this.resolvePythonBin();
    const scriptDir = dirname(input.scriptPath);
    const timeoutMs = this.resolveTimeoutMs();
    const args = [
      input.scriptPath,
      "--config",
      input.configPath,
      "--work-dir",
      input.workDir,
    ];

    this.logger.log(`Spawning shortvideo pipeline: ${pythonBin} ${args.join(" ")}`);

    return new Promise<string>((resolvePromise, rejectPromise) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;

      const child = spawn(pythonBin, args, {
        cwd: scriptDir,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 8_000).unref();
        settleReject(new Error(`ShortVideo pipeline timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const append = (target: "out" | "err", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "out") {
          stdoutBuf = (stdoutBuf + text).slice(-MAX_LOG_BUFFER);
        } else {
          stderrBuf = (stderrBuf + text).slice(-MAX_LOG_BUFFER);
        }
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const stepLine = [...lines].reverse().find((l) => l.includes("[STEP "));
        const line = stepLine || lines[lines.length - 1];
        if (line) {
          void this.shortVideoService.updateRuntimeMessage(input.id, line.slice(0, 500));
        }
      };

      child.stdout?.on("data", (c) => append("out", c));
      child.stderr?.on("data", (c) => append("err", c));

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      };

      const settleResolve = (path: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(path);
      };

      child.on("error", (err) => settleReject(err));
      child.on("close", (code) => {
        const combined = `${stdoutBuf}\n${stderrBuf}`;
        const doneMatch = combined.match(/DONE:\s*(.+)/);
        if (code === 0 && doneMatch?.[1]) {
          const outPath = doneMatch[1].trim();
          if (existsSync(outPath)) {
            settleResolve(outPath);
            return;
          }
        }
        const fallback = join(input.workDir, "output", "short_video.mp4");
        if (code === 0 && existsSync(fallback)) {
          settleResolve(fallback);
          return;
        }
        const failMatch = combined.match(/\[SHORTVIDEO_FAILED]\s*(.+)/);
        settleReject(
          new Error(
            failMatch?.[1]?.trim() ||
              `ShortVideo pipeline exited with code ${code}. Tail: ${combined.slice(-2000)}`,
          ),
        );
      });
    });
  }
}
