import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { decryptSecret, encryptSecret } from "../../common/config/settings-crypto";
import { PlatformCredential } from "../entities/platform-credential.entity";
import { PLATFORM_CREDENTIAL_CATALOG } from "./platform-credentials.catalog";

@Injectable()
export class PlatformCredentialsService {
  private readonly logger = new Logger(PlatformCredentialsService.name);
  private cache = new Map<string, string>();
  private lastFetched = 0;
  private readonly TTL_MS = 60_000;

  constructor(
    @InjectRepository(PlatformCredential) // Main DB connection
    private readonly credentialRepo: Repository<PlatformCredential>,
  ) {}

  private async syncCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastFetched < this.TTL_MS && this.cache.size > 0) {
      return;
    }
    try {
      const records = await this.credentialRepo.find();
      const map = new Map<string, string>();
      for (const row of records) {
        if (row.isSecret) {
          try {
            map.set(row.code, decryptSecret(row.value));
          } catch {
            this.logger.error(`Failed to decrypt platform credential: ${row.code}`);
          }
        } else {
          map.set(row.code, row.value);
        }
      }
      this.cache = map;
      this.lastFetched = now;
    } catch (err) {
      this.logger.warn(`Could not sync platform credentials from DB: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async get(code: string): Promise<string> {
    await this.syncCache();
    const cached = this.cache.get(code);
    if (cached != null && cached !== "") {
      return cached;
    }
    const fromEnv = process.env[code]?.trim();
    if (fromEnv) {
      return fromEnv;
    }
    const def = PLATFORM_CREDENTIAL_CATALOG.find((item) => item.code === code);
    return def?.defaultValue ?? "";
  }

  async require(code: string): Promise<string> {
    const val = await this.get(code);
    if (!val) {
      throw new ServiceUnavailableException(`Platform credential '${code}' is not configured`);
    }
    return val;
  }

  async list(): Promise<Array<{
    provider: string;
    code: string;
    label: string;
    isSecret: boolean;
    configured: boolean;
    source: "db" | "env" | "default" | "none";
    value?: string;
    masked?: string;
  }>> {
    await this.syncCache();
    const results = [];
    for (const def of PLATFORM_CREDENTIAL_CATALOG) {
      const inDb = this.cache.get(def.code);
      const inEnv = process.env[def.code]?.trim();
      let source: "db" | "env" | "default" | "none" = "none";
      let actual = "";

      if (inDb != null && inDb !== "") {
        source = "db";
        actual = inDb;
      } else if (inEnv) {
        source = "env";
        actual = inEnv;
      } else if (def.defaultValue) {
        source = "default";
        actual = def.defaultValue;
      }

      const configured = Boolean(actual);
      if (def.isSecret) {
        const masked = configured ? `••••${actual.slice(-4)}` : "";
        results.push({
          provider: def.provider,
          code: def.code,
          label: def.label,
          isSecret: true,
          configured,
          source,
          masked,
        });
      } else {
        results.push({
          provider: def.provider,
          code: def.code,
          label: def.label,
          isSecret: false,
          configured,
          source,
          value: actual,
        });
      }
    }
    return results;
  }

  async upsert(
    items: Array<{ code: string; value?: string; clear?: boolean }>,
  ): Promise<void> {
    for (const item of items) {
      const def = PLATFORM_CREDENTIAL_CATALOG.find((c) => c.code === item.code);
      if (!def) continue;

      if (item.clear) {
        await this.credentialRepo.delete({ code: item.code });
        this.cache.delete(item.code);
        continue;
      }

      const trimmed = (item.value ?? "").trim();
      if (!trimmed) continue;

      const storedValue = def.isSecret ? encryptSecret(trimmed) : trimmed;
      let existing = await this.credentialRepo.findOne({ where: { code: item.code } });
      if (!existing) {
        existing = this.credentialRepo.create({
          provider: def.provider,
          code: def.code,
          isSecret: def.isSecret,
          description: def.label,
          value: storedValue,
        });
      } else {
        existing.value = storedValue;
      }
      await this.credentialRepo.save(existing);
      this.cache.set(item.code, trimmed);
    }
    this.lastFetched = Date.now();
  }
}

