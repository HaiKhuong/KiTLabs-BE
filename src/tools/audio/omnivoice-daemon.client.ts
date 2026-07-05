import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { createInterface, Interface as ReadlineInterface } from "readline";
import { resolve } from "path";

import { VIDEO_PIPELINE_DIR } from "./audio.constants";

type DaemonResponse = {
  id?: string;
  ok?: boolean;
  error?: string;
  type?: string;
  version?: number;
  pid?: number;
};

type SynthesizePayload = Record<string, unknown>;

@Injectable()
export class OmnivoiceDaemonClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OmnivoiceDaemonClient.name);
  private child: ChildProcess | null = null;
  private stdoutReader: ReadlineInterface | null = null;
  private ready = false;
  private bootPromise: Promise<void> | null = null;
  private bootResolve: (() => void) | null = null;
  private bootReject: ((err: Error) => void) | null = null;
  private bootTimer: NodeJS.Timeout | null = null;
  private pending:
    | {
        id: string;
        resolve: () => void;
        reject: (err: Error) => void;
        timeoutHandle: NodeJS.Timeout;
        audioHistoryId?: string;
      }
    | null = null;
  private readonly queue: Array<{
    id: string;
    payload: SynthesizePayload;
    audioHistoryId?: string;
    timeoutMs: number;
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private shuttingDown = false;

  isEnabled(): boolean {
    const raw = (process.env.AUDIO_OMNIVOICE_DAEMON ?? "true").trim().toLowerCase();
    return raw !== "false" && raw !== "0" && raw !== "no";
  }

  resolvePythonBin(): string {
    return (
      process.env.AUDIO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  resolveDaemonScript(): string {
    const raw = (process.env.AUDIO_OMNIVOICE_DAEMON_SCRIPT ?? "tools/video-pipeline/audio_tts_daemon.py").trim();
    return resolve(process.cwd(), raw);
  }

  resolveBootTimeoutMs(): number {
    return Number(process.env.AUDIO_DAEMON_BOOT_TIMEOUT_MS ?? 120_000);
  }

  async onModuleInit(): Promise<void> {
    if (!this.isEnabled()) {
      this.logger.log("OmniVoice daemon disabled (AUDIO_OMNIVOICE_DAEMON=false) — spawn CLI per request");
      return;
    }
    try {
      await this.ensureReady();
      this.logger.log(`OmniVoice daemon ready (pid=${this.child?.pid ?? "?"})`);
    } catch (err) {
      this.logger.warn(
        `OmniVoice daemon failed to start — falling back to CLI per request: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.killChild();
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    await this.shutdown();
  }

  isReady(): boolean {
    return this.isEnabled() && this.ready && this.child != null && !this.child.killed;
  }

  async synthesize(payload: SynthesizePayload, audioHistoryId?: string, timeoutMs?: number): Promise<void> {
    if (!this.isEnabled()) {
      throw new Error("Daemon not enabled");
    }
    await this.ensureReady();
    const effectiveTimeout = timeoutMs ?? Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? 600_000);

    return new Promise<void>((resolvePromise, rejectPromise) => {
      this.queue.push({
        id: randomUUID(),
        payload,
        audioHistoryId,
        timeoutMs: effectiveTimeout,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      void this.pumpQueue();
    });
  }

  cancelActive(audioHistoryId: string): void {
    if (this.pending?.audioHistoryId === audioHistoryId) {
      this.logger.warn(`Cancelling OmniVoice daemon request for audio ${audioHistoryId}`);
      this.rejectPending(new Error("Audio generation cancelled"));
      void this.restart("cancelled");
      return;
    }
    const idx = this.queue.findIndex((item) => item.audioHistoryId === audioHistoryId);
    if (idx >= 0) {
      const [item] = this.queue.splice(idx, 1);
      item.reject(new Error("Audio generation cancelled"));
    }
  }

  private async ensureReady(): Promise<void> {
    if (this.isReady()) return;
    if (this.bootPromise) {
      await this.bootPromise;
      return;
    }
    this.bootPromise = this.startDaemon();
    try {
      await this.bootPromise;
    } finally {
      this.bootPromise = null;
    }
    if (!this.isReady()) {
      throw new Error("OmniVoice daemon not ready");
    }
  }

  private async startDaemon(): Promise<void> {
    this.killChild();
    const pythonBin = this.resolvePythonBin();
    const scriptPath = this.resolveDaemonScript();
    const scriptDir = resolve(process.cwd(), VIDEO_PIPELINE_DIR);

    this.ready = false;
    this.child = spawn(pythonBin, [scriptPath], {
      cwd: scriptDir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    await new Promise<void>((resolveBoot, rejectBoot) => {
      this.bootResolve = resolveBoot;
      this.bootReject = rejectBoot;
      this.bootTimer = setTimeout(() => {
        this.finishBoot(new Error(`OmniVoice daemon boot timeout after ${this.resolveBootTimeoutMs()}ms`));
      }, this.resolveBootTimeoutMs());

      const child = this.child;
      if (!child?.stdout) {
        this.finishBoot(new Error("Daemon stdout unavailable"));
        return;
      }

      this.stdoutReader = createInterface({ input: child.stdout });
      this.stdoutReader.on("line", (line) => this.onStdoutLine(line));

      child.stderr?.on("data", (buf: Buffer) => {
        const text = buf.toString("utf8").trim();
        if (text) this.logger.debug(`[daemon stderr] ${text}`);
      });

      child.on("error", (err) => {
        this.finishBoot(err);
      });

      child.on("close", (code, signal) => {
        this.ready = false;
        if (this.pending) {
          const suffix = signal ? ` signal ${signal}` : ` code ${code ?? "?"}`;
          this.rejectPending(new Error(`OmniVoice daemon exited unexpectedly${suffix}`));
        }
        if (this.bootReject) {
          this.finishBoot(new Error(`OmniVoice daemon exited before ready (code=${code ?? "?"})`));
        }
        void this.pumpQueue();
      });
    });
  }

  private finishBoot(err?: Error): void {
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    const resolveBoot = this.bootResolve;
    const rejectBoot = this.bootReject;
    this.bootResolve = null;
    this.bootReject = null;
    if (!resolveBoot && !rejectBoot) return;
    if (err) {
      rejectBoot?.(err);
    } else {
      resolveBoot?.();
    }
  }

  private onStdoutLine(line: string): void {
    if (!line.trim()) return;
    let msg: DaemonResponse;
    try {
      msg = JSON.parse(line) as DaemonResponse;
    } catch {
      this.logger.debug(`[daemon stdout] ${line}`);
      return;
    }

    if (msg.type === "ready" && !this.ready) {
      this.ready = true;
      this.finishBoot();
      return;
    }

    this.handleResponse(msg);
  }

  private handleResponse(msg: DaemonResponse): void {
    if (!this.pending || msg.id !== this.pending.id) return;
    clearTimeout(this.pending.timeoutHandle);
    const current = this.pending;
    this.pending = null;

    if (msg.ok) {
      current.resolve();
    } else {
      current.reject(new Error(msg.error?.trim() || "OmniVoice daemon synthesize failed"));
    }
    void this.pumpQueue();
  }

  private async pumpQueue(): Promise<void> {
    if (this.pending || this.queue.length === 0) return;
    if (!this.isReady()) {
      try {
        await this.ensureReady();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        while (this.queue.length > 0) {
          this.queue.shift()?.reject(new Error(message));
        }
        return;
      }
    }

    const item = this.queue.shift();
    if (!item || !this.child?.stdin) return;

    this.pending = {
      id: item.id,
      resolve: item.resolve,
      reject: item.reject,
      audioHistoryId: item.audioHistoryId,
      timeoutHandle: setTimeout(() => {
        this.rejectPending(new Error(`OmniVoice TTS timed out after ${item.timeoutMs}ms`));
        void this.restart("timeout");
      }, item.timeoutMs),
    };

    const request = JSON.stringify({
      id: item.id,
      cmd: "synthesize",
      payload: item.payload,
    });
    this.child.stdin.write(`${request}\n`);
  }

  private rejectPending(err: Error): void {
    if (!this.pending) return;
    clearTimeout(this.pending.timeoutHandle);
    const current = this.pending;
    this.pending = null;
    current.reject(err);
  }

  private async restart(reason: string): Promise<void> {
    if (this.shuttingDown) return;
    this.logger.warn(`Restarting OmniVoice daemon (${reason})`);
    this.killChild();
    try {
      await this.ensureReady();
      void this.pumpQueue();
    } catch (err) {
      this.logger.error(
        `OmniVoice daemon restart failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private killChild(): void {
    this.ready = false;
    this.stdoutReader?.close();
    this.stdoutReader = null;
    if (this.bootTimer) {
      clearTimeout(this.bootTimer);
      this.bootTimer = null;
    }
    this.bootResolve = null;
    this.bootReject = null;
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      child.kill("SIGTERM");
    }
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child?.stdin || child.killed) {
      this.killChild();
      return;
    }
    try {
      const id = randomUUID();
      child.stdin.write(`${JSON.stringify({ id, cmd: "shutdown" })}\n`);
    } catch {
      // ignore
    }
    await new Promise<void>((resolveDone) => {
      const timer = setTimeout(() => {
        this.killChild();
        resolveDone();
      }, 3_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveDone();
      });
    });
    this.killChild();
  }
}
