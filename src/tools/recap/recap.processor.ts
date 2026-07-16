import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { RECAP_QUEUE_NAME, RecapService } from "./recap.service";

const MAX_LOG_BUFFER = 8 * 1024 * 1024;

@Processor(RECAP_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: RecapService.resolveQueueLockDurationMs(),
  stalledInterval: 180_000,
  maxStalledCount: 2,
})
export class RecapProcessor extends WorkerHost {
  private readonly logger = new Logger(RecapProcessor.name);

  constructor(
    private readonly recapService: RecapService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {
    super();
  }

  private resolvePythonBin(): string {
    return (
      process.env.RECAP_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveScriptPath(): string {
    const raw = process.env.RECAP_PYTHON_SCRIPT ?? "tools/video-pipeline/recap/run_recap.py";
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }

  private resolveTimeoutMs(): number {
    return Number(process.env.RECAP_CMD_TIMEOUT_MS ?? 3_600_000);
  }

  async process(job: Job<{ recapHistoryId: string }>): Promise<void> {
    const recapHistoryId = job.data?.recapHistoryId;
    if (!recapHistoryId) {
      throw new UnrecoverableError("recapHistoryId is required");
    }

    const history = await this.recapService.getById(recapHistoryId);
    if (!history) {
      throw new UnrecoverableError(`Recap history not found: ${recapHistoryId}`);
    }

    try {
      await this.recapService.processStarted(recapHistoryId);

      const workDir = this.recapService.prepareWorkDir(recapHistoryId);
      const configPath = this.recapService.writeJobConfig(workDir, history);
      const scriptPath = this.resolveScriptPath();
      if (!existsSync(scriptPath)) {
        throw new UnrecoverableError(`Recap python script not found: ${scriptPath}`);
      }

      const videoPath = String(history.engineConfig?.localVideoPath ?? "");
      if (!videoPath || !existsSync(videoPath)) {
        throw new UnrecoverableError(`Source video missing: ${videoPath}`);
      }

      const resultPath = await this.spawnPipeline({
        recapHistoryId,
        scriptPath,
        videoPath,
        workDir,
        configPath,
      });

      const scriptPayload = this.recapService.readJsonIfExists(join(workDir, "script.json"));
      const timelinePayload = this.recapService.readJsonIfExists(join(workDir, "timeline.json"));

      await this.recapService.processCompleted(recapHistoryId, resultPath, {
        scriptPayload,
        timelinePayload,
      });

      const completed = await this.recapService.getById(recapHistoryId);
      const mapped = completed ? this.recapService.mapHistoryForClient(completed) : null;
      this.realtimeGateway.notifyUser(completed?.userId ?? "all", "recap.completed", {
        recapHistoryId,
        resultPath,
        resultFileName: mapped?.resultFileName ?? null,
        playUrl: mapped?.playUrl ?? null,
        downloadUrl: mapped?.downloadUrl ?? null,
        scriptPayload: mapped?.scriptPayload ?? null,
        timelinePayload: mapped?.timelinePayload ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = job.opts.attempts != null ? Number(job.opts.attempts) : 1;
      const attemptsMade = job.attemptsMade != null ? Number(job.attemptsMade) : 0;
      const isUnrecoverable =
        error instanceof UnrecoverableError || (error instanceof Error && error.name === "UnrecoverableError");
      const willRetry = !isUnrecoverable && attemptsMade + 1 < maxAttempts;

      if (willRetry) {
        this.logger.warn(
          `Recap job ${job.id} failed (attempt ${attemptsMade + 1}/${maxAttempts}), will retry: ${message}`,
        );
        throw error;
      }

      await this.recapService.processFailed(recapHistoryId, message);
      const failed = await this.recapService.getById(recapHistoryId);
      this.realtimeGateway.notifyUser(failed?.userId ?? "all", "recap.failed", {
        recapHistoryId,
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }

  private spawnPipeline(input: {
    recapHistoryId: string;
    scriptPath: string;
    videoPath: string;
    workDir: string;
    configPath: string;
  }): Promise<string> {
    const pythonBin = this.resolvePythonBin();
    const scriptDir = dirname(input.scriptPath);
    const timeoutMs = this.resolveTimeoutMs();
    const args = [
      input.scriptPath,
      "--video",
      input.videoPath,
      "--work-dir",
      input.workDir,
      "--config",
      input.configPath,
    ];

    this.logger.log(`Spawning recap pipeline: ${pythonBin} ${args.join(" ")}`);

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
        settleReject(new Error(`Recap pipeline timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const append = (target: "out" | "err", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "out") {
          stdoutBuf = (stdoutBuf + text).slice(-MAX_LOG_BUFFER);
        } else {
          stderrBuf = (stderrBuf + text).slice(-MAX_LOG_BUFFER);
        }
        const line = text.trim();
        if (line) {
          void this.recapService.updateRuntimeMessage(
            input.recapHistoryId,
            line.slice(0, 500),
          );
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
        const fallback = join(input.workDir, "output", "recap.mp4");
        if (code === 0 && existsSync(fallback)) {
          settleResolve(fallback);
          return;
        }
        const failMatch = combined.match(/\[RECAP_FAILED]\s*(.+)/);
        settleReject(
          new Error(
            failMatch?.[1]?.trim() ||
              `Recap pipeline exited with code ${code}. Tail: ${combined.slice(-2000)}`,
          ),
        );
      });
    });
  }
}
