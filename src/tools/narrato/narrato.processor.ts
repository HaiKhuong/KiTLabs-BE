import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { NARRATO_QUEUE_NAME, NarratoService } from "./narrato.service";
import { NARRATO_STEP_SCRIPTS, type NarratoStepId } from "./narrato-steps.constants";

const MAX_LOG_BUFFER = 8 * 1024 * 1024;

@Processor(NARRATO_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: NarratoService.resolveQueueLockDurationMs(),
  stalledInterval: 180_000,
  maxStalledCount: 2,
})
export class NarratoProcessor extends WorkerHost {
  private readonly logger = new Logger(NarratoProcessor.name);

  constructor(
    private readonly narratoService: NarratoService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
  ) {
    super();
  }

  private resolvePythonBin(): string {
    return (
      process.env.NARRATO_PYTHON_BIN ??
      process.env.RECAP_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveScriptDir(): string {
    const raw = process.env.NARRATO_PYTHON_DIR ?? "tools/video-pipeline/narrato";
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  }

  private resolveTimeoutMs(): number {
    return Number(process.env.NARRATO_CMD_TIMEOUT_MS ?? process.env.RECAP_CMD_TIMEOUT_MS ?? 3_600_000);
  }

  async process(job: Job<{ narratoHistoryId: string; step: NarratoStepId }>): Promise<void> {
    const narratoHistoryId = job.data?.narratoHistoryId;
    const step = job.data?.step;
    if (!narratoHistoryId) {
      throw new UnrecoverableError("narratoHistoryId is required");
    }
    if (!step || !NARRATO_STEP_SCRIPTS[step]) {
      throw new UnrecoverableError(`Invalid narrato step: ${String(step)}`);
    }

    const history = await this.narratoService.getById(narratoHistoryId);
    if (!history) {
      throw new UnrecoverableError(`Narrato history not found: ${narratoHistoryId}`);
    }

    try {
      await this.narratoService.markStepStarted(narratoHistoryId, step);
      await this.narratoService.updateRuntimeMessage(narratoHistoryId, `[STEP] ${step} — spawning Python`);

      const workDir = this.narratoService.prepareWorkDir(history);
      this.narratoService.syncScriptToWorkDir(history);
      const configPath = this.narratoService.writeJobConfig(workDir, history);
      const scriptPath = join(this.resolveScriptDir(), NARRATO_STEP_SCRIPTS[step]);
      if (!existsSync(scriptPath)) {
        throw new UnrecoverableError(`Narrato step script not found: ${scriptPath}`);
      }

      const videoPath = String(history.engineConfig?.localVideoPath ?? "");
      if (!videoPath || !existsSync(videoPath)) {
        throw new UnrecoverableError(`Source video missing: ${videoPath}`);
      }

      const resultPath = await this.spawnStep({
        narratoHistoryId,
        step,
        scriptPath,
        videoPath,
        workDir,
        configPath,
      });

      const scriptPayload = this.narratoService.readJsonIfExists(join(workDir, "script.json"));
      const plotText = this.narratoService.readTextIfExists(join(workDir, "plot.md"));
      const copyText = this.narratoService.readTextIfExists(join(workDir, "narration_copy.txt"));

      await this.narratoService.markStepCompleted(narratoHistoryId, step, {
        resultPath: step === "render" ? resultPath : undefined,
        scriptPayload: scriptPayload ?? undefined,
        plotText,
        copyText,
      });

      const completed = await this.narratoService.getById(narratoHistoryId);
      const mapped = completed ? this.narratoService.mapHistoryForClient(completed) : null;
      this.realtimeGateway.notifyUser(completed?.userId ?? "all", "narrato.completed", {
        narratoHistoryId,
        step,
        resultPath: resultPath ?? null,
        resultFileName: mapped?.resultFileName ?? null,
        playUrl: mapped?.playUrl ?? null,
        downloadUrl: mapped?.downloadUrl ?? null,
        scriptPayload: mapped?.scriptPayload ?? null,
        plotAnalysis: mapped?.plotAnalysis ?? null,
        narrationCopy: mapped?.narrationCopy ?? null,
        stepProgress: mapped?.stepProgress ?? null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const maxAttempts = job.opts.attempts != null ? Number(job.opts.attempts) : 1;
      const attemptsMade = job.attemptsMade != null ? Number(job.attemptsMade) : 0;
      const isUnrecoverable =
        error instanceof UnrecoverableError ||
        (error instanceof Error && error.name === "UnrecoverableError");
      const willRetry = !isUnrecoverable && attemptsMade + 1 < maxAttempts;

      if (willRetry) {
        this.logger.warn(
          `Narrato step ${step} job ${job.id} failed (attempt ${attemptsMade + 1}/${maxAttempts}): ${message}`,
        );
        throw error;
      }

      await this.narratoService.markStepFailed(narratoHistoryId, step, message);
      const failed = await this.narratoService.getById(narratoHistoryId);
      this.realtimeGateway.notifyUser(failed?.userId ?? "all", "narrato.failed", {
        narratoHistoryId,
        step,
        errorMessage: message,
        terminal: true,
        stepProgress: failed ? this.narratoService.mapHistoryForClient(failed).stepProgress : null,
      });
      throw error;
    }
  }

  private spawnStep(input: {
    narratoHistoryId: string;
    step: NarratoStepId;
    scriptPath: string;
    videoPath: string;
    workDir: string;
    configPath: string;
  }): Promise<string | undefined> {
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

    this.logger.log(`Spawning narrato step ${input.step}: ${pythonBin} ${args.join(" ")}`);

    return new Promise<string | undefined>((resolvePromise, rejectPromise) => {
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

      void this.narratoService.updateRuntimeMessage(
        input.narratoHistoryId,
        `[STEP] ${input.step} — Python pid=${child.pid}`,
      );

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 8_000).unref();
        settleReject(new Error(`Narrato step timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const append = (target: "out" | "err", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "out") stdoutBuf = (stdoutBuf + text).slice(-MAX_LOG_BUFFER);
        else stderrBuf = (stderrBuf + text).slice(-MAX_LOG_BUFFER);
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const stepLine = [...lines].reverse().find((l) => l.includes("[STEP ") || l.includes("[NARRATO]"));
        const line = stepLine || lines[lines.length - 1];
        if (line) {
          void this.narratoService.updateRuntimeMessage(input.narratoHistoryId, line.slice(0, 500));
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

      const settleResolve = (path?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(path);
      };

      child.on("error", (err) => settleReject(err));
      child.on("close", (code) => {
        const combined = `${stdoutBuf}\n${stderrBuf}`;
        const doneMatch = combined.match(/DONE:\s*(.+)/);
        if (code === 0) {
          if (doneMatch?.[1]) {
            const outPath = doneMatch[1].trim();
            if (outPath.endsWith(".mp4") && existsSync(outPath)) {
              settleResolve(outPath);
              return;
            }
          }
          if (input.step === "render") {
            const fallback = join(input.workDir, "output", "narrato.mp4");
            if (existsSync(fallback)) {
              settleResolve(fallback);
              return;
            }
          }
          settleResolve(undefined);
          return;
        }
        const failMatch = combined.match(/\[NARRATO_FAILED]\s*(.+)/);
        settleReject(
          new Error(
            failMatch?.[1]?.trim() ||
              `Narrato step ${input.step} exited with code ${code}. Tail: ${combined.slice(-2000)}`,
          ),
        );
      });
    });
  }
}
