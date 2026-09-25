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
  "TIKTOK_CLIENT_SECRET",
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
  {
    code: "RENDER_CANCEL_DELETE_FILES",
    group: "jobs",
    kind: "boolean",
    label: "Xóa toàn bộ file khi hủy",
    defaultValue: "true",
  },
  { code: "TRANSLATE_WORK_ROOT", group: "translate", kind: "string", label: "Translate work folder", defaultValue: "" },
  { code: "RECAP_WORK_ROOT", group: "recap", kind: "string", label: "Recap work folder", defaultValue: "" },
  { code: "RECAP_WHISPER_MODEL", group: "recap", kind: "string", label: "Recap Whisper model", defaultValue: "base" },
  { code: "RECAP_WHISPER_DEVICE", group: "recap", kind: "string", label: "Recap Whisper device", defaultValue: "cpu" },
  { code: "RECAP_VLM_ENABLED", group: "recap", kind: "boolean", label: "Recap VLM (Qwen2.5-VL)", defaultValue: "true" },
  { code: "RECAP_VLM_MODEL", group: "recap", kind: "string", label: "Recap VLM model", defaultValue: "Qwen/Qwen2.5-VL-3B-Instruct" },
  { code: "RECAP_VLM_MAX_SHOTS", group: "recap", kind: "number", label: "Recap VLM max frames / event", defaultValue: "6" },
  { code: "RECAP_VLM_MAX_NEW_TOKENS", group: "recap", kind: "number", label: "Recap VLM max new tokens", defaultValue: "128" },
  { code: "RECAP_GEMINI_MODEL", group: "recap", kind: "string", label: "Recap Gemini model", defaultValue: "gemini-2.5-flash" },
  { code: "RECAP_GEMINI_KEY_TIER", group: "recap", kind: "string", label: "Recap Gemini key tier", defaultValue: "vip" },
  { code: "RECAP_GEMINI_RETRY_MAX", group: "recap", kind: "number", label: "Recap Gemini retry max", defaultValue: "1" },
  { code: "RECAP_GEMINI_RETRY_DEBOUNCE_SEC", group: "recap", kind: "number", label: "Recap Gemini retry debounce (s)", defaultValue: "3" },
  { code: "RECAP_TRANSCRIPT_MAX_CHARS", group: "recap", kind: "number", label: "Recap transcript max chars", defaultValue: "120000" },
  { code: "SHORTVIDEO_WORK_ROOT", group: "shortvideo", kind: "string", label: "ShortVideo work folder", defaultValue: "" },
  { code: "AUDIO_WORK_ROOT", group: "audio", kind: "string", label: "Voice work folder", defaultValue: "" },
  { code: "WHITEBOARD_WORK_ROOT", group: "whiteboard", kind: "string", label: "Whiteboard work folder", defaultValue: "" },
  { code: "YTDLP_SERVICE_URL", group: "services", kind: "string", label: "yt-dlp service URL", defaultValue: "http://localhost:8100" },
  { code: "DOUYIN_PLAYWRIGHT_SERVICE_URL", group: "services", kind: "string", label: "Playwright service URL", defaultValue: "http://localhost:8101" },
  { code: "DOUYIN_COOKIE_CONTENT", group: "douyin", kind: "secret", label: "Douyin cookies", defaultValue: "" },
  { code: "TIKTOK_CLIENT_KEY", group: "tiktok", kind: "string", label: "TikTok Client Key", defaultValue: "" },
  { code: "TIKTOK_CLIENT_SECRET", group: "tiktok", kind: "secret", label: "TikTok Client Secret", defaultValue: "" },
  {
    code: "TIKTOK_REDIRECT_URI",
    group: "tiktok",
    kind: "string",
    label: "TikTok Redirect URI",
    defaultValue: "http://127.0.0.1:13002/api/tiktok/callback",
  },
  { code: "GEMINI_API_KEY", group: "gemini", kind: "secret", label: "Gemini API key thường (nhiều key: cách nhau dấu phẩy)", defaultValue: "" },
  { code: "GEMINI_API_KEY_VIP", group: "gemini", kind: "secret", label: "Gemini API key VIP (nhiều key: cách nhau dấu phẩy)", defaultValue: "" },
  /** Shared by Cấu hình runtime + Model AI — one settings row, both UIs read/write this code. */
  { code: "HF_TOKEN", group: "gemini", kind: "secret", label: "Hugging Face token", defaultValue: "" },
];

export const RUNTIME_CODE_SET = new Set(RUNTIME_SETTING_FIELDS.map((f) => f.code));
