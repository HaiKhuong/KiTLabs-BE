import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import axios from "axios";
import { execFile } from "child_process";
import * as os from "os";
import { promisify } from "util";
import { DataSource } from "typeorm";

import { AppConfigService } from "../../common/config/app-config.service";
import { RedisService } from "../../database/redis.service";

const execFileAsync = promisify(execFile);

export type RuntimeHealthCheck = {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
};

export type RuntimeMachineInfo = {
  cpu: string;
  cores: number;
  ramGb: number;
  gpu: string;
  vramGb: number | null;
};

const PROBE_TIMEOUT_MS = 3000;
const MACHINE_TTL_MS = 60_000;
const HEALTH_STEP_IDS = ["api", "postgres", "postgres_audit", "redis", "ytdlp", "playwright"] as const;

@Injectable()
export class RuntimeHealthService {
  private machineCache: { at: number; value: RuntimeMachineInfo } | null = null;

  constructor(
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
    @InjectDataSource() private readonly mainDataSource: DataSource,
    @InjectDataSource("audit") private readonly auditDataSource: DataSource,
  ) {}

  async checkAll(): Promise<{
    ok: boolean;
    checks: RuntimeHealthCheck[];
    machine: RuntimeMachineInfo;
  }> {
    const [api, postgres, audit, redis, ytdlp, playwright, machine] = await Promise.all([
      this.probe("api", "Nest API", async () => undefined),
      this.probe("postgres", "PostgreSQL", () => this.mainDataSource.query("SELECT 1")),
      this.probe("postgres_audit", "PostgreSQL audit", () => this.auditDataSource.query("SELECT 1")),
      this.probe("redis", "Redis", () => this.redis.ping()),
      this.probe("ytdlp", "yt-dlp", () => this.httpHealth(this.appConfig.get("YTDLP_SERVICE_URL", "http://localhost:8100"))),
      this.probe(
        "playwright",
        "Playwright",
        () =>
          this.httpHealth(
            this.appConfig.get("DOUYIN_PLAYWRIGHT_SERVICE_URL", "http://localhost:8101"),
          ),
      ),
      this.readMachine(),
    ]);
    const checks = [api, postgres, audit, redis, ytdlp, playwright];
    const byId = new Map(checks.map((check) => [check.id, check]));
    const ok = HEALTH_STEP_IDS.every((id) => byId.get(id)?.ok === true);
    return { ok, checks, machine };
  }

  private async readMachine(): Promise<RuntimeMachineInfo> {
    const now = Date.now();
    if (this.machineCache && now - this.machineCache.at < MACHINE_TTL_MS) {
      return this.machineCache.value;
    }

    const nvidia = await this.readNvidiaGpu();
    const gpu = nvidia?.gpu ?? (await this.readWindowsGpuName()) ?? "—";
    const cpuModel = os.cpus()[0]?.model?.trim() || "—";
    const value: RuntimeMachineInfo = {
      cpu: cpuModel,
      cores: os.cpus().length,
      ramGb: Math.round(os.totalmem() / 1024 ** 3),
      gpu,
      vramGb: nvidia?.vramGb ?? null,
    };
    this.machineCache = { at: now, value };
    return value;
  }

  private async readNvidiaGpu(): Promise<{ gpu: string; vramGb: number } | null> {
    try {
      const { stdout } = await execFileAsync(
        "nvidia-smi",
        ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
        { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 64 },
      );
      const line = stdout.trim().split(/\r?\n/).find((row) => row.includes(","));
      if (!line) return null;
      const [rawName, rawMem] = line.split(",").map((part) => part.trim());
      const memMiB = Number(rawMem);
      if (!rawName) return null;
      return {
        gpu: rawName,
        vramGb: Number.isFinite(memMiB) ? Math.round((memMiB / 1024) * 10) / 10 : 0,
      };
    } catch {
      return null;
    }
  }

  private async readWindowsGpuName(): Promise<string | null> {
    if (process.platform !== "win32") return null;
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name"],
        { timeout: 2500, windowsHide: true, maxBuffer: 1024 * 32 },
      );
      const name = stdout.trim();
      return name || null;
    } catch {
      return null;
    }
  }

  private async httpHealth(baseUrl: string): Promise<void> {
    const url = `${baseUrl.replace(/\/$/, "")}/health`;
    const response = await axios.get(url, { timeout: PROBE_TIMEOUT_MS });
    if (response.status >= 400) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  private async probe(
    id: string,
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<RuntimeHealthCheck> {
    const started = Date.now();
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("timeout")), PROBE_TIMEOUT_MS);
        }),
      ]);
      return { id, label, ok: true, latencyMs: Date.now() - started };
    } catch (error) {
      const message = error instanceof Error ? error.message : "unhealthy";
      return { id, label, ok: false, latencyMs: Date.now() - started, error: message };
    }
  }
}
