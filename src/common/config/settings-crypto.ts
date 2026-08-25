import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const PREFIX = "enc:v1:";

function keyBytes(): Buffer {
  const raw = (process.env.SETTINGS_ENCRYPTION_KEY ?? "").trim();
  if (!raw) {
    throw new Error("SETTINGS_ENCRYPTION_KEY is required to encrypt settings secrets");
  }
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 64) {
    return Buffer.from(raw, "hex");
  }
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) {
    return b64;
  }
  return Buffer.from(raw.padEnd(32, "0").slice(0, 32), "utf8");
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, enc]).toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) {
    return stored;
  }
  const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskGeminiKeys(raw: string): { configured: boolean; keyCount: number; masked: string } {
  const parts = raw
    .split(/[,;\n|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    return { configured: false, keyCount: 0, masked: "" };
  }
  const first = parts[0];
  const last4 = first.slice(-4);
  const prefix = first.startsWith("AIza") ? "AIza" : first.slice(0, 4);
  return {
    configured: true,
    keyCount: parts.length,
    masked: `${prefix}••••${last4}`,
  };
}
