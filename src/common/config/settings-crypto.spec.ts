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

  it("masks each gemini key with prefix, dots, and suffix", () => {
    const mask = maskGeminiKeys("aaGBSsecretvalueGBX, sjnjdfsecretvalueHSHS");
    expect(mask.configured).toBe(true);
    expect(mask.keyCount).toBe(2);
    expect(mask.masked).toBe("aaGBS..............GBX, sjnjd..............HSH");
  });
});
