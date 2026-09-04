import { ConfigService } from "@nestjs/config";

export type GeminiKeyTier = "normal" | "vip";

function dedupeKeys(keys: string[]): string[] {
  return [...new Set(keys)];
}

/**
 * Parse giá trị env Gemini key — hỗ trợ nhiều định dạng:
 * - 1 key: AIzaSy...
 * - Nhiều key: key1,key2 hoặc key1;key2 hoặc key1|key2
 * - Xuống dòng (trong .env quoted): key1\nkey2
 * - JSON array: ["key1","key2"]
 */
export function parseGeminiApiKeys(raw: string | undefined | null): string[] {
  if (!raw?.trim()) return [];

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return dedupeKeys(
          parsed
            .map((item) =>
              typeof item === "string" ? item.trim() : String(item ?? "").trim(),
            )
            .filter(Boolean),
        );
      }
    } catch {
      // fallback split
    }
  }

  return dedupeKeys(
    trimmed
      .split(/[,;\n|]+/)
      .map((key) => key.trim())
      .filter(Boolean),
  );
}

/** normal = GEMINI_API_KEY + GOOGLE_API_KEY; vip = GEMINI_API_KEY_VIP */
export function loadGeminiKeyPools(config?: ConfigService): {
  normal: string[];
  vip: string[];
} {
  const read = (name: string) => process.env[name] || config?.get<string>(name);
  const normal = dedupeKeys([
    ...parseGeminiApiKeys(read("GEMINI_API_KEY")),
    ...parseGeminiApiKeys(read("GOOGLE_API_KEY")),
  ]);
  const vip = parseGeminiApiKeys(read("GEMINI_API_KEY_VIP"));
  return { normal, vip };
}

export function resolveGeminiKeyTier(input?: string): GeminiKeyTier {
  return input?.trim().toLowerCase() === "vip" ? "vip" : "normal";
}

export function geminiKeyPoolEnvHint(tier: GeminiKeyTier): string {
  return tier === "vip"
    ? "GEMINI_API_KEY_VIP"
    : "GEMINI_API_KEY (hoặc GOOGLE_API_KEY)";
}

/** Prefer the normal pool; fall back to VIP so Settings → Pipeline keys work after boot. */
export function resolveLiveGeminiKeys(config?: ConfigService): string[] {
  const pools = loadGeminiKeyPools(config);
  return pools.normal.length > 0 ? pools.normal : pools.vip;
}

export function missingGeminiKeyMessage(tier: GeminiKeyTier = "normal"): string {
  return `Gemini API key chưa cấu hình. Cấu hình ${geminiKeyPoolEnvHint(tier)} trong Settings → Pipeline (hoặc .env).`;
}
