export type RuntimeSettingKind = "string" | "number" | "boolean" | "secret";

export type RuntimeSettingField = {
  code: string;
  group: string;
  kind: RuntimeSettingKind;
  label: string;
  defaultValue: string;
};

export const RUNTIME_SETTING_TYPE = "runtime";

export const SECRET_SETTING_CODES = new Set([
  "GEMINI_API_KEY",
  "GEMINI_API_KEY_VIP",
  "HF_TOKEN",
  "DOUYIN_COOKIE_CONTENT",
]);

/** Stored as `${code}__App` / `${code}__Web` so one Nest can keep both cookies. */
export const PLATFORM_SCOPED_SECRET_CODES = new Set(["DOUYIN_COOKIE_CONTENT"]);

export function runtimeStorageCode(code: string, platform: "App" | "Web"): string {
  if (!PLATFORM_SCOPED_SECRET_CODES.has(code)) {
    return code;
  }
  return `${code}__${platform}`;
}

export const RUNTIME_SETTING_FIELDS: RuntimeSettingField[] = [
  { code: "OMNIVOICE_SEED", group: "omnivoice", kind: "string", label: "OmniVoice seed", defaultValue: "42" },
  { code: "OMNIVOICE_NUM_STEP", group: "omnivoice", kind: "number", label: "OmniVoice steps", defaultValue: "32" },
  { code: "OMNIVOICE_GUIDANCE_SCALE", group: "omnivoice", kind: "number", label: "OmniVoice CFG", defaultValue: "2" },
  { code: "OMNIVOICE_DENOISE", group: "omnivoice", kind: "boolean", label: "OmniVoice denoise", defaultValue: "true" },
  { code: "OMNIVOICE_PREPROCESS_PROMPT", group: "omnivoice", kind: "boolean", label: "OmniVoice preprocess", defaultValue: "true" },
  { code: "OMNIVOICE_POSTPROCESS_OUTPUT", group: "omnivoice", kind: "boolean", label: "OmniVoice postprocess", defaultValue: "true" },
  { code: "OMNIVOICE_NORMALIZE_TEXT", group: "omnivoice", kind: "boolean", label: "OmniVoice normalize text", defaultValue: "false" },
  { code: "OMNIVOICE_BATCH_SIZE", group: "omnivoice", kind: "number", label: "OmniVoice batch size", defaultValue: "8" },
  { code: "STEP3_VERBOSE_LOG", group: "omnivoice", kind: "boolean", label: "Step3 verbose log", defaultValue: "false" },
  { code: "VOXCPM2_SEED", group: "voxcpm", kind: "string", label: "VoxCPM2 seed", defaultValue: "42" },
  { code: "TRANSLATE_CMD_TIMEOUT_MS", group: "translate", kind: "number", label: "Translate timeout (ms)", defaultValue: "1200000" },
  { code: "TRANSLATE_WORK_ROOT", group: "translate", kind: "string", label: "Translate output folder", defaultValue: "" },
  { code: "RECAP_CMD_TIMEOUT_MS", group: "recap", kind: "number", label: "Recap timeout (ms)", defaultValue: "3600000" },
  { code: "RECAP_WORK_ROOT", group: "recap", kind: "string", label: "Recap work folder", defaultValue: "" },
  { code: "RECAP_WHISPER_MODEL", group: "recap", kind: "string", label: "Recap Whisper model", defaultValue: "base" },
  { code: "RECAP_WHISPER_DEVICE", group: "recap", kind: "string", label: "Recap Whisper device", defaultValue: "cpu" },
  { code: "RECAP_GEMINI_MODEL", group: "recap", kind: "string", label: "Recap Gemini model", defaultValue: "gemini-2.5-flash" },
  { code: "RECAP_GEMINI_KEY_TIER", group: "recap", kind: "string", label: "Recap Gemini key tier", defaultValue: "vip" },
  { code: "RECAP_GEMINI_RETRY_MAX", group: "recap", kind: "number", label: "Recap Gemini retry max", defaultValue: "1" },
  { code: "RECAP_GEMINI_RETRY_DEBOUNCE_SEC", group: "recap", kind: "number", label: "Recap Gemini retry debounce (s)", defaultValue: "3" },
  { code: "RECAP_TRANSCRIPT_MAX_CHARS", group: "recap", kind: "number", label: "Recap transcript max chars", defaultValue: "120000" },
  { code: "SHORTVIDEO_CMD_TIMEOUT_MS", group: "shortvideo", kind: "number", label: "ShortVideo timeout (ms)", defaultValue: "1800000" },
  { code: "SHORTVIDEO_WORK_ROOT", group: "shortvideo", kind: "string", label: "ShortVideo work folder", defaultValue: "" },
  { code: "YTDLP_SERVICE_URL", group: "services", kind: "string", label: "yt-dlp service URL", defaultValue: "http://localhost:8100" },
  { code: "DOUYIN_PLAYWRIGHT_SERVICE_URL", group: "services", kind: "string", label: "Playwright service URL", defaultValue: "http://localhost:8101" },
  { code: "DOUYIN_COOKIE_CONTENT", group: "douyin", kind: "secret", label: "Douyin cookies", defaultValue: "" },
  { code: "GEMINI_API_KEY", group: "gemini", kind: "secret", label: "Gemini API key (normal)", defaultValue: "" },
  { code: "GEMINI_API_KEY_VIP", group: "gemini", kind: "secret", label: "Gemini API key (VIP)", defaultValue: "" },
  { code: "HF_TOKEN", group: "gemini", kind: "secret", label: "Hugging Face token", defaultValue: "" },
];

export const RUNTIME_CODE_SET = new Set(RUNTIME_SETTING_FIELDS.map((f) => f.code));
