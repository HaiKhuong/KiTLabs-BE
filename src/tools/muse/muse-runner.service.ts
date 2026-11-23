import { BadRequestException, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

import { AppConfigService } from "../../common/config/app-config.service";
import { pythonSubprocessEnv, resolvePythonBin } from "../../common/desktop/python-path";

export type MuseCookieSource = "db" | "secrets" | "cli" | "none";

export type MuseStatusResponse = {
  configured: boolean;
  connected: boolean;
  source: MuseCookieSource;
  vmId: string | null;
  sessions?: number;
  unread?: number;
  identity?: Record<string, unknown> | null;
  error?: string | null;
};

export type MuseGenerateImageInput = {
  prompt: string;
  outputFile: string;
  aspect?: string;
  style?: string;
  negativePrompt?: string;
};

export type MuseGenerateVideoInput = {
  prompt: string;
  outputFile: string;
  aspect?: string;
  duration?: number;
};

type RunnerResult = {
  ok: boolean;
  error?: string;
  code?: string;
  outputPath?: string;
  threadId?: string;
  vmId?: string;
  replyText?: string;
  connected?: boolean;
  sessions?: number;
  unread?: number;
  identity?: Record<string, unknown>;
  cookies?: string;
};

@Injectable()
export class MuseRunnerService {
  private readonly logger = new Logger(MuseRunnerService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  private resolveRunnerScript(): string {
    const scriptPath = resolve(process.cwd(), "tools", "muse", "muse_cli_runner.py");
    if (!existsSync(scriptPath)) {
      throw new InternalServerErrorException(`Không tìm thấy script Muse tại ${scriptPath}`);
    }
    return scriptPath;
  }

  private resolvePython(): string {
    return resolvePythonBin(["MUSE_PYTHON_BIN", "GFLOW_PYTHON_BIN", "VIDEO_PIPELINE_PYTHON_BIN", "IMAGE_PIPELINE_PYTHON_BIN"]);
  }

  resolveCookieSource(): { source: MuseCookieSource; cookies: string; cookieFile?: string } {
    const fromDb = this.appConfig.getSecret("MUSE_COOKIE_CONTENT").trim();
    if (fromDb) {
      return { source: "db", cookies: fromDb };
    }
    const secretsFile = resolve(process.cwd(), "secrets", "muse-cookies.txt");
    if (existsSync(secretsFile)) {
      const content = readFileSync(secretsFile, "utf-8").trim();
      if (content) {
        return { source: "secrets", cookies: content, cookieFile: secretsFile };
      }
    }
    const cliFile = join(homedir(), ".config", "muse-cli", "cookies.txt");
    if (existsSync(cliFile)) {
      const content = readFileSync(cliFile, "utf-8").trim();
      if (content) {
        return { source: "cli", cookies: content, cookieFile: cliFile };
      }
    }
    return { source: "none", cookies: "" };
  }

  private async runRunner<T extends RunnerResult>(
    args: string[],
    stdinPayload?: unknown,
    timeoutMs = 120_000,
  ): Promise<T> {
    const pythonBin = this.resolvePython();
    const scriptPath = this.resolveRunnerScript();

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const child = spawn(pythonBin, [scriptPath, ...args], {
        cwd: resolve(process.cwd(), "tools", "muse"),
        env: pythonSubprocessEnv(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        rejectPromise(new InternalServerErrorException(`Muse runner timeout sau ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(new InternalServerErrorException(`Không thể chạy Python Muse: ${err.message}`));
      });

      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const lines = stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        let parsed: T | null = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            parsed = JSON.parse(lines[i]) as T;
            break;
          } catch {
            // continue scanning upwards
          }
        }

        if (!parsed) {
          const detail = (stderr || stdout || `exit code ${code}`).slice(0, 400);
          rejectPromise(new InternalServerErrorException(`Muse lỗi: ${detail}`));
          return;
        }

        if (!parsed.ok) {
          rejectPromise(new BadRequestException(parsed.error || "Muse thực thi thất bại"));
          return;
        }

        resolvePromise(parsed);
      });

      if (stdinPayload !== undefined) {
        child.stdin.write(JSON.stringify(stdinPayload));
      }
      child.stdin.end();
    });
  }

  async getStatus(): Promise<MuseStatusResponse> {
    const resolved = this.resolveCookieSource();
    if (resolved.source === "none") {
      return {
        configured: false,
        connected: false,
        source: "none",
        vmId: null,
        identity: null,
        error: null,
      };
    }
    try {
      const res = await this.runRunner<RunnerResult>(
        ["--action", "status"],
        { cookies: resolved.cookies, cookieFile: resolved.cookieFile },
        30_000,
      );
      return {
        configured: true,
        connected: Boolean(res.connected),
        source: resolved.source,
        vmId: res.vmId ?? null,
        sessions: res.sessions ?? 0,
        unread: res.unread ?? 0,
        identity: res.identity ?? null,
        error: null,
      };
    } catch (err) {
      return {
        configured: true,
        connected: false,
        source: resolved.source,
        vmId: null,
        identity: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async saveCookies(cookieHeader: string): Promise<MuseStatusResponse> {
    const clean = cookieHeader.trim();
    if (!clean || !clean.includes("hatch_sess=")) {
      throw new BadRequestException("Cookie không hợp lệ: cần chứa hatch_sess=...");
    }
    const check = await this.runRunner<RunnerResult>(
      ["--action", "status"],
      { cookies: clean },
      30_000,
    );
    await this.appConfig.upsertRuntime("MUSE_COOKIE_CONTENT", clean);
    this.logger.log(`[Muse] Saved encrypted MUSE_COOKIE_CONTENT (vmId=${check.vmId ?? "unknown"})`);
    return {
      configured: true,
      connected: Boolean(check.connected),
      source: "db",
      vmId: check.vmId ?? null,
      sessions: check.sessions ?? 0,
      unread: check.unread ?? 0,
      identity: check.identity ?? null,
      error: null,
    };
  }

  async clearCookies(): Promise<MuseStatusResponse> {
    await this.appConfig.upsertRuntime("MUSE_COOKIE_CONTENT", "", { clear: true });
    return this.getStatus();
  }

  async exportFromBrowser(): Promise<MuseStatusResponse> {
    const res = await this.runRunner<RunnerResult>(["--action", "auth-export"], undefined, 45_000);
    if (!res.cookies) {
      throw new BadRequestException("Không đọc được cookie từ Chrome.");
    }
    return this.saveCookies(res.cookies);
  }

  async generateImage(input: MuseGenerateImageInput): Promise<{ outputPath: string; threadId?: string }> {
    const resolved = this.resolveCookieSource();
    if (resolved.source === "none") {
      throw new BadRequestException("Chưa cấu hình cookie Muse.ai. Vui lòng vào Settings → Muse AI để kết nối.");
    }
    const threadId = this.appConfig.get("MUSE_THREAD_ID").trim() || undefined;
    const res = await this.runRunner<RunnerResult>(
      ["--action", "generate-image"],
      {
        ...input,
        cookies: resolved.cookies,
        cookieFile: resolved.cookieFile,
        threadId,
        timeout: 180,
      },
      210_000,
    );
    if (res.threadId && res.threadId !== threadId) {
      await this.appConfig.upsertRuntime("MUSE_THREAD_ID", res.threadId).catch(() => undefined);
    }
    return { outputPath: res.outputPath ?? input.outputFile, threadId: res.threadId };
  }

  async generateVideo(input: MuseGenerateVideoInput): Promise<{ outputPath: string; threadId?: string }> {
    const resolved = this.resolveCookieSource();
    if (resolved.source === "none") {
      throw new BadRequestException("Chưa cấu hình cookie Muse.ai. Vui lòng vào Settings → Muse AI để kết nối.");
    }
    const threadId = this.appConfig.get("MUSE_THREAD_ID").trim() || undefined;
    const res = await this.runRunner<RunnerResult>(
      ["--action", "generate-video"],
      {
        ...input,
        cookies: resolved.cookies,
        cookieFile: resolved.cookieFile,
        threadId,
        timeout: 420,
      },
      450_000,
    );
    if (res.threadId && res.threadId !== threadId) {
      await this.appConfig.upsertRuntime("MUSE_THREAD_ID", res.threadId).catch(() => undefined);
    }
    return { outputPath: res.outputPath ?? input.outputFile, threadId: res.threadId };
  }
}
