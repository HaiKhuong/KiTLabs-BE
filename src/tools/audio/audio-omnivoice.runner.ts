import { Injectable, Logger } from "@nestjs/common";
import { ChildProcess, spawn } from "child_process";
import { existsSync } from "fs";
import { basename, dirname, isAbsolute, resolve } from "path";

import {
  AUDIO_PYTHON_SCRIPT,
  buildOmnivoiceSpawnEnv,
  resolveAudioPythonBin,
  resolveAudioPythonTimeoutMs,
} from "./audio.constants";

export type OmnivoiceTtsPayload = Record<string, unknown>;

const MAX_PYTHON_LOG_BUFFER = 64 * 1024;

@Injectable()
export class AudioOmnivoiceRunner {
  private readonly logger = new Logger(AudioOmnivoiceRunner.name);
  private readonly activeChildren = new Map<string, ChildProcess>();
  private readonly cancelledJobs = new Set<string>();

  resolveScriptPath(): string {
    const raw = (process.env.AUDIO_PYTHON_SCRIPT ?? AUDIO_PYTHON_SCRIPT).trim();
    let abs = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);

    // omnivoice_tts.py là library — chạy trực tiếp sẽ exit 0 ngay, không tạo WAV.
    if (basename(abs).toLowerCase() === "omnivoice_tts.py") {
      const studio = resolve(dirname(abs), "audio_studio_tts.py");
      this.logger.warn(
        `AUDIO_PYTHON_SCRIPT=omnivoice_tts.py — chuyển sang ${studio.replace(/\\/g, "/")}`,
      );
      abs = studio;
    }

    if (!existsSync(abs)) {
      throw new Error(`Audio Python script not found: ${abs.replace(/\\/g, "/")}`);
    }
    return abs;
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

  clearCancel(audioHistoryId: string): void {
    this.cancelledJobs.delete(audioHistoryId);
    this.activeChildren.delete(audioHistoryId);
  }

  /**
   * Gọi ``audio_studio_tts.py`` (stdin JSON → audio_tts_with_pauses → omnivoice_tts).
   */
  async execute(payload: OmnivoiceTtsPayload, audioHistoryId?: string): Promise<void> {
    const pythonBin = resolveAudioPythonBin();
    const absScriptPath = this.resolveScriptPath();
    const scriptDir = dirname(absScriptPath);
    const timeoutMs = resolveAudioPythonTimeoutMs();
    const outWav = String(payload.out_wav ?? "");

    this.logger.log(
      `OmniVoice python: ${basename(absScriptPath)} out=${outWav.replace(/\\/g, "/")} ` +
        `pid_target=${audioHistoryId ?? "preview"}`,
    );

    const startedAt = Date.now();

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [absScriptPath], {
        cwd: scriptDir,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: buildOmnivoiceSpawnEnv(),
      });

      this.logger.log(`Python pid=${child.pid ?? "?"}`);

      if (audioHistoryId) {
        this.activeChildren.set(audioHistoryId, child);
      }

      let stderr = "";
      let stdout = "";
      const timeoutHandle = setTimeout(() => {
        this.logger.error(`OmniVoice timed out after ${timeoutMs}ms, killing...`);
        child.kill("SIGTERM");
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutHandle);
        if (audioHistoryId) {
          this.activeChildren.delete(audioHistoryId);
        }
      };

      const appendChunk = (target: "stdout" | "stderr", chunk: string) => {
        if (target === "stdout") {
          stdout += chunk;
          if (stdout.length > MAX_PYTHON_LOG_BUFFER) {
            stdout = stdout.slice(-MAX_PYTHON_LOG_BUFFER);
          }
        } else {
          stderr += chunk;
          if (stderr.length > MAX_PYTHON_LOG_BUFFER) {
            stderr = stderr.slice(-MAX_PYTHON_LOG_BUFFER);
          }
        }
      };

      const echoChunk = (chunk: string, level: "log" | "warn") => {
        const trimmed = chunk.trimEnd();
        if (!trimmed) return;
        if (level === "warn") {
          this.logger.warn(`[py] ${trimmed}`);
        } else {
          this.logger.log(`[py] ${trimmed}`);
        }
      };

      child.stdout?.on("data", (buf: Buffer) => {
        const message = buf.toString("utf8");
        appendChunk("stdout", message);
        echoChunk(message, "log");
      });

      child.stderr?.on("data", (buf: Buffer) => {
        const message = buf.toString("utf8");
        appendChunk("stderr", message);
        echoChunk(message, "warn");
      });

      child.on("error", (err) => {
        cleanup();
        rejectPromise(err);
      });

      child.on("close", (code, signal) => {
        cleanup();
        const elapsedMs = Date.now() - startedAt;
        this.logger.log(`OmniVoice done code=${code ?? "?"} ${elapsedMs}ms`);

        if (audioHistoryId && this.isCancelled(audioHistoryId)) {
          rejectPromise(new Error("Audio generation cancelled"));
          return;
        }

        if (code !== 0) {
          const suffix = signal ? ` (signal ${signal})` : "";
          const detail = stderr.trim() || stdout.trim() || `exited with code ${code}${suffix}`;
          rejectPromise(
            new Error(
              `${detail} | script=${absScriptPath.replace(/\\/g, "/")} out_wav=${outWav.replace(/\\/g, "/")}`,
            ),
          );
          return;
        }

        if (outWav && !existsSync(outWav)) {
          rejectPromise(
            new Error(
              `${basename(absScriptPath)} thoát 0 (${elapsedMs}ms) nhưng không tạo WAV. ` +
                `Dùng audio_studio_tts.py — omnivoice_tts.py chỉ là library import.`,
            ),
          );
          return;
        }

        resolvePromise();
      });

      child.stdin?.write(JSON.stringify(payload));
      child.stdin?.end();
    });

    if (!outWav || !existsSync(outWav)) {
      throw new Error(`OmniVoice did not produce output: ${outWav.replace(/\\/g, "/")}`);
    }
  }
}
