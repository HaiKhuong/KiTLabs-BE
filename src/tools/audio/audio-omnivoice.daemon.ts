import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ChildProcess, spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { randomUUID } from "crypto";

import { KITLABS_PYTHON_CACHE_ROOT } from "./audio.constants";
import type { OmnivoiceRunInput } from "./audio-omnivoice.runner";

type DaemonResponse = {
  id?: string;
  ok?: boolean;
  out?: string;
  error?: string;
  pong?: boolean;
};

type QueueItem = {
  input: OmnivoiceRunInput;
  resolve: (outWav: string) => void;
  reject: (err: Error) => void;
};

function logPythonStreamLines(logger: Logger, chunk: string, level: "log" | "warn"): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (level === "warn") logger.warn(trimmed);
    else logger.log(trimmed);
  }
}

function buildPythonChildEnv(): NodeJS.ProcessEnv {
  const base = KITLABS_PYTHON_CACHE_ROOT;
  const hf = join(base, "huggingface");
  const torch = join(base, "torch");
  mkdirSync(hf, { recursive: true });
  mkdirSync(torch, { recursive: true });
  return {
    ...process.env,
    ...(process.env.HF_HOME ? {} : { HF_HOME: hf }),
    ...(process.env.TRANSFORMERS_CACHE ? {} : { TRANSFORMERS_CACHE: hf }),
    ...(process.env.XDG_CACHE_HOME ? {} : { XDG_CACHE_HOME: base }),
    ...(process.env.TORCH_HOME ? {} : { TORCH_HOME: torch }),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

function resolvePythonBin(): string {
  return (
    process.env.AUDIO_PYTHON_BIN ??
    process.env.TRANSLATE_PYTHON_BIN ??
    (process.platform === "win32" ? "py" : "python3")
  );
}

function resolveDaemonScriptPath(): string {
  const scriptPath =
    process.env.AUDIO_OMNIVOICE_DAEMON_SCRIPT ??
    join("tools", "video-pipeline", "audio_tts_daemon.py");
  return isAbsolute(scriptPath) ? scriptPath : resolve(process.cwd(), scriptPath);
}

export function isOmnivoiceDaemonEnabled(): boolean {
  const raw = (process.env.AUDIO_OMNIVOICE_DAEMON ?? "true").trim().toLowerCase();
  return raw !== "false" && raw !== "0" && raw !== "off";
}

/** Giữ một process Python — cache model/prompt như auto_vietsub_pro. */
export class OmnivoiceDaemonPool {
  private readonly logger = new Logger("OmniVoiceDaemon");

  private proc: ChildProcess | null = null;
  private stdoutBuf = "";
  private readonly pending = new Map<
    string,
    { resolve: (res: DaemonResponse) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private readyPromise: Promise<void> | null = null;
  private bootResolver: (() => void) | null = null;
  private bootRejecter: ((err: Error) => void) | null = null;
  private jobQueue: QueueItem[] = [];
  private draining = false;

  async synthesize(input: OmnivoiceRunInput): Promise<string> {
    return new Promise((resolve, reject) => {
      this.jobQueue.push({ input, resolve, reject });
      void this.drainQueue();
    });
  }

  async shutdown(): Promise<void> {
    this.jobQueue = [];
    if (!this.proc?.stdin?.writable) {
      this.killProcess();
      return;
    }
    try {
      await this.sendCommand({ id: randomUUID(), cmd: "shutdown" }, 15_000);
    } catch {
      this.killProcess();
    }
  }

  private async drainQueue(): Promise<void> {
    if (this.draining || this.jobQueue.length === 0) return;
    this.draining = true;
    while (this.jobQueue.length > 0) {
      const job = this.jobQueue.shift()!;
      try {
        const outWav = await this.synthesizeOnce(job.input);
        job.resolve(outWav);
      } catch (err) {
        job.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.draining = false;
  }

  private async synthesizeOnce(input: OmnivoiceRunInput): Promise<string> {
    const refAudio = isAbsolute(input.refAudio)
      ? input.refAudio
      : resolve(process.cwd(), input.refAudio);
    const outWav = isAbsolute(input.outWav) ? input.outWav : resolve(process.cwd(), input.outWav);
    if (!existsSync(refAudio)) {
      throw new Error(`Reference audio not found: ${refAudio}`);
    }

    const modelId = (input.modelId ?? process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim();
    const deviceMap = (input.deviceMap ?? process.env.OMNIVOICE_DEVICE_MAP ?? "").trim();
    const timeoutMs = Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600000);

    const id = randomUUID();
    this.logger.log(
      `daemon request id=${id} textLen=${input.text.length} ref=${refAudio} out=${outWav}`,
    );

    const res = await this.sendCommand(
      {
        id,
        cmd: "synthesize",
        text: input.text,
        out: outWav,
        ref_audio: refAudio,
        ref_text: input.refText ?? "",
        model_id: modelId,
        device_map: deviceMap,
        dtype: input.dtype ?? process.env.OMNIVOICE_DTYPE ?? "float16",
        language: input.language ?? process.env.OMNIVOICE_LANGUAGE ?? "vietnamese",
        num_step: input.numStep ?? Number(process.env.OMNIVOICE_NUM_STEP ?? 8),
        guidance_scale: input.guidanceScale ?? Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2),
        ...(input.seed !== undefined && input.seed !== null ? { seed: input.seed } : {}),
      },
      timeoutMs,
    );

    if (!res.ok) {
      throw new Error(res.error ?? "OmniVoice daemon synthesize failed");
    }
    if (!res.out || !existsSync(res.out)) {
      throw new Error(`OmniVoice daemon did not produce output: ${outWav}`);
    }
    return res.out;
  }

  private async ensureReady(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.startProcess();
    return this.readyPromise;
  }

  private async startProcess(): Promise<void> {
    const pythonBin = resolvePythonBin();
    const daemonPath = resolveDaemonScriptPath();
    if (!existsSync(daemonPath)) {
      throw new Error(`OmniVoice daemon script not found: ${daemonPath}`);
    }
    const scriptDir = dirname(daemonPath);

    this.logger.log(`starting daemon bin=${pythonBin} script=${daemonPath}`);

    const proc = spawn(pythonBin, [daemonPath], {
      cwd: scriptDir,
      windowsHide: true,
      env: buildPythonChildEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.stdoutBuf = "";

    proc.stdout?.on("data", (buf) => this.onStdout(buf.toString("utf8")));
    proc.stderr?.on("data", (buf) => logPythonStreamLines(this.logger, buf.toString("utf8"), "warn"));

    const bootTimeoutMs = Number(process.env.AUDIO_DAEMON_BOOT_TIMEOUT_MS ?? 120_000);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.bootResolver = null;
        this.bootRejecter = null;
        reject(new Error(`OmniVoice daemon boot timeout after ${bootTimeoutMs}ms`));
      }, bootTimeoutMs);

      this.bootResolver = () => {
        clearTimeout(timer);
        this.bootRejecter = null;
        this.logger.log("daemon ready (model loads on first synthesize)");
        resolve();
      };
      this.bootRejecter = (err) => {
        clearTimeout(timer);
        this.bootResolver = null;
        reject(err);
      };

      proc.on("error", (err) => {
        this.bootRejecter?.(err);
      });

      proc.on("close", (code) => {
        this.logger.warn(`daemon exited code=${code ?? "?"}`);
        this.proc = null;
        this.readyPromise = null;
        const err = new Error(`OmniVoice daemon exited with code ${code ?? "?"}`);
        this.bootRejecter?.(err);
        for (const [, p] of this.pending.entries()) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        this.pending.clear();
      });
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: DaemonResponse;
      try {
        parsed = JSON.parse(line) as DaemonResponse;
      } catch {
        this.logger.warn(`daemon non-json stdout: ${line.slice(0, 200)}`);
        continue;
      }
      const id = parsed.id ?? "";
      if (id === "__ready__" && parsed.ok) {
        this.bootResolver?.();
        this.bootResolver = null;
        continue;
      }
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(parsed);
      }
    }
  }

  private async sendCommand(payload: Record<string, unknown>, timeoutMs: number): Promise<DaemonResponse> {
    await this.ensureReady();
    if (!this.proc?.stdin?.writable) {
      this.readyPromise = null;
      await this.ensureReady();
    }

    const id = String(payload.id ?? randomUUID());
    const line = `${JSON.stringify({ ...payload, id })}\n`;

    return new Promise<DaemonResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`OmniVoice daemon request timeout after ${timeoutMs}ms (id=${id})`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      this.proc?.stdin?.write(line, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private killProcess(): void {
    if (this.proc && !this.proc.killed) {
      this.proc.kill("SIGTERM");
    }
    this.proc = null;
    this.readyPromise = null;
  }
}

let sharedPool: OmnivoiceDaemonPool | null = null;

export function getOmnivoiceDaemonPool(): OmnivoiceDaemonPool {
  if (!sharedPool) sharedPool = new OmnivoiceDaemonPool();
  return sharedPool;
}

@Injectable()
export class OmnivoiceDaemonService implements OnModuleDestroy {
  private readonly logger = new Logger(OmnivoiceDaemonService.name);

  onModuleDestroy(): void {
    if (!isOmnivoiceDaemonEnabled()) return;
    this.logger.log("shutting down OmniVoice daemon");
    void getOmnivoiceDaemonPool().shutdown();
  }
}
