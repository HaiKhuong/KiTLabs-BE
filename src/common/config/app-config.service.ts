import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";

import { getRequestPlatform } from "../desktop/request-platform";
import { Setting } from "../../tools/settings/setting.entity";
import {
  PLATFORM_SCOPED_SECRET_CODES,
  RUNTIME_SETTING_FIELDS,
  RUNTIME_SETTING_TYPE,
  SECRET_SETTING_CODES,
  runtimeStorageCode,
} from "./runtime-settings.catalog";
import { decryptSecret, encryptSecret, isEncryptedSecret, maskGeminiKeys } from "./settings-crypto";

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);
  private readonly secretCache = new Map<string, string>();

  constructor(
    @InjectRepository(Setting, "tool")
    private readonly settingRepository: Repository<Setting>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncFromDb();
  }

  async syncFromDb(): Promise<void> {
    const rows = await this.settingRepository.find({ where: { type: RUNTIME_SETTING_TYPE } });
    const byCode = new Map(rows.map((r) => [r.code, r.value]));
    for (const field of RUNTIME_SETTING_FIELDS) {
      if (PLATFORM_SCOPED_SECRET_CODES.has(field.code)) {
        for (const platform of ["App", "Web"] as const) {
          const storageCode = runtimeStorageCode(field.code, platform);
          const stored = byCode.get(storageCode);
          if (stored == null || stored === "") {
            continue;
          }
          try {
            this.secretCache.set(storageCode, decryptSecret(stored));
          } catch {
            this.logger.error(`Failed to decrypt ${storageCode}`);
          }
        }
        continue;
      }
      const stored = byCode.get(field.code);
      if (stored == null || stored === "") {
        continue;
      }
      if (SECRET_SETTING_CODES.has(field.code)) {
        try {
          const plain = decryptSecret(stored);
          this.secretCache.set(field.code, plain);
          process.env[field.code] = plain;
        } catch {
          this.logger.error(`Failed to decrypt ${field.code}`);
        }
        continue;
      }
      process.env[field.code] = stored;
    }
  }

  get(code: string, fallback?: string): string {
    const fromEnv = process.env[code];
    if (fromEnv != null && fromEnv !== "") {
      return fromEnv;
    }
    const field = RUNTIME_SETTING_FIELDS.find((f) => f.code === code);
    return fallback ?? field?.defaultValue ?? "";
  }

  getSecret(code: string): string {
    if (PLATFORM_SCOPED_SECRET_CODES.has(code)) {
      const storageCode = runtimeStorageCode(code, getRequestPlatform());
      return this.secretCache.get(storageCode) ?? "";
    }
    return this.secretCache.get(code) ?? process.env[code] ?? "";
  }

  private storageCodeFor(code: string): string {
    if (PLATFORM_SCOPED_SECRET_CODES.has(code)) {
      return runtimeStorageCode(code, getRequestPlatform());
    }
    return code;
  }

  private maskSecret(code: string, plain: string): { configured: boolean; keyCount: number; masked: string } {
    if (code === "DOUYIN_COOKIE_CONTENT") {
      const trimmed = plain.trim();
      if (!trimmed) {
        return { configured: false, keyCount: 0, masked: "" };
      }
      return { configured: true, keyCount: 1, masked: `cookie••••${trimmed.slice(-4)}` };
    }
    return maskGeminiKeys(plain);
  }

  spawnEnv(): NodeJS.ProcessEnv {
    return { ...process.env };
  }

  async listRuntime() {
    const rows = await this.settingRepository.find({ where: { type: RUNTIME_SETTING_TYPE } });
    const byCode = new Map(rows.map((r) => [r.code, r.value]));
    return RUNTIME_SETTING_FIELDS.map((field) => {
      const storageCode = this.storageCodeFor(field.code);
      const stored = byCode.get(storageCode) ?? "";
      if (field.kind === "secret") {
        let plain = "";
        if (stored) {
          try {
            plain = decryptSecret(stored);
          } catch {
            plain = "";
          }
        } else if (!PLATFORM_SCOPED_SECRET_CODES.has(field.code)) {
          plain = process.env[field.code] ?? "";
        }
        const mask = this.maskSecret(field.code, plain);
        return {
          ...field,
          value: "",
          configured: mask.configured,
          keyCount: mask.keyCount,
          masked: mask.masked,
        };
      }
      const value = stored || process.env[field.code] || field.defaultValue;
      return { ...field, value, configured: Boolean(value), keyCount: 0, masked: "" };
    });
  }

  async upsertRuntime(code: string, value: string): Promise<void> {
    const field = RUNTIME_SETTING_FIELDS.find((f) => f.code === code);
    if (!field) {
      return;
    }
    if (field.kind === "secret" && !value.trim()) {
      return;
    }
    const storageCode = this.storageCodeFor(code);
    let stored = value;
    if (field.kind === "secret") {
      stored = encryptSecret(value);
      this.secretCache.set(storageCode, value);
      if (!PLATFORM_SCOPED_SECRET_CODES.has(code)) {
        process.env[code] = value;
      }
    } else {
      process.env[code] = value;
    }
    const existed = await this.settingRepository.findOne({
      where: { type: RUNTIME_SETTING_TYPE, code: storageCode },
    });
    if (existed) {
      existed.value = stored;
      await this.settingRepository.save(existed);
      return;
    }
    await this.settingRepository.save(
      this.settingRepository.create({ type: RUNTIME_SETTING_TYPE, code: storageCode, value: stored }),
    );
  }

  isEncryptedRow(value: string): boolean {
    return isEncryptedSecret(value);
  }
}
