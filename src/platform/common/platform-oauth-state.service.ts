import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { randomBytes } from "crypto";
import Redis from "ioredis";

@Injectable()
export class PlatformOAuthStateService implements OnModuleDestroy {
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? "localhost",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  async create(provider: "facebook" | "tiktok", userId: string): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const ttlSeconds =
      provider === "facebook"
        ? Number(process.env.META_OAUTH_STATE_TTL_SECONDS ?? 600)
        : Number(process.env.TIKTOK_OAUTH_STATE_TTL_SECONDS ?? 600);
    await this.redis.set(this.key(provider, state), userId, "EX", ttlSeconds, "NX");
    return state;
  }

  async consume(provider: "facebook" | "tiktok", state: string): Promise<string | null> {
    if (!state || state.length > 200) return null;
    const result = await this.redis.eval(
      "local value=redis.call('GET',KEYS[1]); if value then redis.call('DEL',KEYS[1]); end; return value",
      1,
      this.key(provider, state),
    );
    return typeof result === "string" ? result : null;
  }

  async createHandoff(provider: "facebook" | "tiktok", payload: object): Promise<string> {
    const ticket = randomBytes(32).toString("base64url");
    const ttlSeconds = Number(process.env.OAUTH_HANDOFF_TTL_SECONDS ?? 180);
    await this.redis.set(
      this.handoffKey(provider, ticket),
      JSON.stringify(payload),
      "EX",
      ttlSeconds,
      "NX",
    );
    return ticket;
  }

  async consumeHandoff(provider: "facebook" | "tiktok", ticket: string): Promise<Record<string, unknown> | null> {
    if (!ticket || ticket.length > 200) return null;
    const result = await this.redis.eval(
      "local value=redis.call('GET',KEYS[1]); if value then redis.call('DEL',KEYS[1]); end; return value",
      1,
      this.handoffKey(provider, ticket),
    );
    if (typeof result !== "string") return null;
    try {
      return JSON.parse(result) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private key(provider: "facebook" | "tiktok", state: string): string {
    return `${provider}:oauth-state:${state}`;
  }

  private handoffKey(provider: "facebook" | "tiktok", ticket: string): string {
    return `${provider}:oauth-handoff:${ticket}`;
  }
}

