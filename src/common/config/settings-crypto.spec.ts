import { decryptSecret, encryptSecret, maskGeminiKeys } from "./settings-crypto";

describe("settings-crypto", () => {
  const prev = process.env.SETTINGS_ENCRYPTION_KEY;

  beforeAll(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = "a".repeat(64);
  });

  afterAll(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = prev;
  });

  it("round-trips AES-256-GCM", () => {
    const plain = "AIzaSyAAA,AIzaSyBBB";
    const enc = encryptSecret(plain);
    expect(enc.startsWith("enc:v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it("masks gemini keys", () => {
    const mask = maskGeminiKeys("AIzaSySecretKeyXXXX");
    expect(mask.configured).toBe(true);
    expect(mask.keyCount).toBe(1);
    expect(mask.masked.includes("••••")).toBe(true);
  });
});
