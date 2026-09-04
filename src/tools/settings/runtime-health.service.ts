import { Injectable } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import axios from "axios";
import { DataSource } from "typeorm";

import { AppConfigService } from "../../common/config/app-config.service";
import { RedisService } from "../../database/redis.service";

export type RuntimeHealthCheck = {
  id: string;
  label: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
};

const PROBE_TIMEOUT_MS = 3000;

@Injectable()
export class RuntimeHealthService {
  constructor(
    private readonly appConfig: AppConfigService,
    private readonly redis: RedisService,
    @InjectDataSource() private readonly mainDataSource: DataSource,
    @InjectDataSource("audit") private readonly auditDataSource: DataSource,
  ) {}

  async checkAll(): Promise<{ checks: RuntimeHealthCheck[] }> {
    const [api, postgres, audit, redis, ytdlp, playwright] = await Promise.all([
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
    ]);
    return { checks: [api, postgres, audit, redis, ytdlp, playwright] };
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
