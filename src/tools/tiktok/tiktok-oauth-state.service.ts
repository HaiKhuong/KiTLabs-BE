import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "crypto";
import Redis from "ioredis";

@Injectable()
export class TikTokOAuthStateService implements OnModuleDestroy {
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  async create(userId: string): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    await this.redis.set(
      this.key(state),
      userId,
      "EX",
      Number(process.env.TIKTOK_OAUTH_STATE_TTL_SECONDS ?? 600),
      "NX",
    );
    return state;
  }

  async consume(state: string): Promise<string | null> {
    if (!state || state.length > 200) return null;
    const result = await this.redis.eval(
      "local value=redis.call('GET',KEYS[1]); if value then redis.call('DEL',KEYS[1]); end; return value",
      1,
      this.key(state),
    );
    return typeof result === "string" ? result : null;
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private key(state: string): string {
    return `tiktok:oauth-state:${state}`;
  }
}
