import { BadRequestException, Injectable, InternalServerErrorException, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { resolve } from "path";

import { pythonSubprocessEnv, resolvePythonBin } from "../../common/desktop/python-path";

export type GFlowAccountInfo = {
  name: string;
  email: string;
  priority: number;
  status: "available" | "cooldown" | "quota_blocked" | "busy";
  usedToday: number;
  lastUsedAt: number;
  cooldownUntil: number;
  limitReason: string;
  quotaBlockedUntil: number;
  quotaReason: string;
};

export type GFlowPoolStatus = {
  total: number;
  available_count: number;
  available_profiles: string[];
  blocked_count: number;
  blocked_profiles: string[];
  accounts: GFlowAccountInfo[];
};

export type GFlowGenerateVideoInput = {
  prompt: string;
  outputFile: string;
  referenceImage?: string | null;
  aspect?: string;
  model?: string;
  resolution?: string;
  duration?: number;
  voice?: string;
};

export type GFlowGenerateImageInput = {
  prompt: string;
  outputFile: string;
  referenceImage?: string | null;
  aspect?: string;
  model?: string;
};

@Injectable()
export class GFlowRunnerService {
  private readonly logger = new Logger(GFlowRunnerService.name);

  private resolveRunnerScript(): string {
    const scriptPath = resolve(process.cwd(), "tools", "gflow", "gflow_cli_runner.py");
    if (!existsSync(scriptPath)) {
      throw new InternalServerErrorException(`Không tìm thấy script GFlow tại ${scriptPath}`);
    }
    return scriptPath;
  }

  private resolvePython(): string {
    return resolvePythonBin(["GFLOW_PYTHON_BIN", "VIDEO_PIPELINE_PYTHON_BIN", "IMAGE_PIPELINE_PYTHON_BIN"]);
  }

  private async runRunner<T extends { ok: boolean; error?: string }>(
    args: string[],
    stdinPayload?: unknown,
    timeoutMs = 120_000,
  ): Promise<T> {
    const pythonBin = this.resolvePython();
    const scriptPath = this.resolveRunnerScript();

    return new Promise<T>((resolvePromise, rejectPromise) => {
      const child = spawn(pythonBin, [scriptPath, ...args], {
        cwd: resolve(process.cwd(), "tools", "gflow"),
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
        rejectPromise(new InternalServerErrorException(`GFlow runner timeout sau ${Math.round(timeoutMs / 1000)}s`));
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
        rejectPromise(new InternalServerErrorException(`Không thể chạy Python GFlow: ${err.message}`));
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
          rejectPromise(new InternalServerErrorException(`GFlow lỗi: ${detail}`));
          return;
        }

        if (!parsed.ok) {
          rejectPromise(new BadRequestException(parsed.error || "GFlow thực thi thất bại"));
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

  async getPoolStatus(): Promise<GFlowPoolStatus> {
    const res = await this.runRunner<{ ok: boolean; error?: string } & GFlowPoolStatus>(["--action", "status"], undefined, 30_000);
    return {
      total: res.total ?? 0,
      available_count: res.available_count ?? 0,
      available_profiles: res.available_profiles ?? [],
      blocked_count: res.blocked_count ?? 0,
      blocked_profiles: res.blocked_profiles ?? [],
      accounts: res.accounts ?? [],
    };
  }

  async connectAccount(profileName: string): Promise<{ profile: string; pool: GFlowPoolStatus }> {
    const clean = profileName.trim();
    if (!clean || !/^[a-zA-Z0-9_-]{1,40}$/.test(clean)) {
      throw new BadRequestException("Tên profile chỉ gồm chữ, số, dấu gạch dưới hoặc gạch ngang (1-40 ký tự).");
    }
    this.logger.log(`[GFlow] Opening Chrome login for profile=${clean}`);
    return this.runRunner<{ ok: boolean; profile: string; pool: GFlowPoolStatus }>(
      ["--action", "login", "--profile", clean],
      undefined,
      5 * 60_000,
    );
  }

  async openAccountChrome(profileName: string): Promise<{ profile: string }> {
    const clean = profileName.trim();
    if (!clean) throw new BadRequestException("Thiếu tên profile");
    return this.runRunner<{ ok: boolean; profile: string }>(["--action", "open-chrome", "--profile", clean], undefined, 20_000);
  }

  async resetPool(profileName?: string, clearUsage = false): Promise<{ resetProfiles: string[]; pool: GFlowPoolStatus }> {
    const args = ["--action", "reset"];
    if (profileName?.trim()) {
      args.push("--profile", profileName.trim());
    }
    if (clearUsage) {
      args.push("--clear-usage");
    }
    return this.runRunner<{ ok: boolean; resetProfiles: string[]; pool: GFlowPoolStatus }>(args, undefined, 30_000);
  }

  async generateVideo(input: GFlowGenerateVideoInput): Promise<{ outputPath: string; profile?: string }> {
    return this.runRunner<{ ok: boolean; outputPath: string; profile?: string }>(
      ["--action", "generate-video"],
      input,
      6 * 60_000,
    );
  }

  async generateImage(input: GFlowGenerateImageInput): Promise<{ outputPath: string; profile?: string }> {
    return this.runRunner<{ ok: boolean; outputPath: string; profile?: string }>(
      ["--action", "generate-image"],
      input,
      3 * 60_000,
    );
  }
}
