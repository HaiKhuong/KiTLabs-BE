import { mkdirSync } from "fs";
import { join, resolve } from "path";

export const VIDEO_PIPELINE_DIR = join("tools", "video-pipeline");
export const VOICE_SAMPLES_DIR = join(VIDEO_PIPELINE_DIR, "voice");
export const AUDIO_PYTHON_SCRIPT = join(VIDEO_PIPELINE_DIR, "omnivoice_tts.py");

/** Gốc uploads — mặc định `<cwd>/uploads`, ghi đè bằng `AUDIO_DATA_ROOT` nếu cần. */
export const AUDIO_DATA_ROOT = (() => {
  const raw = (process.env.AUDIO_DATA_ROOT ?? process.env.KITLABS_AUDIO_DATA_ROOT ?? "").trim();
  return raw ? resolve(raw) : resolve(process.cwd(), "uploads");
})();

export const AUDIO_CLONE_UPLOAD_DIR = join(AUDIO_DATA_ROOT, "audio-clone");
export const AUDIO_PREVIEW_CACHE_DIR = join(AUDIO_DATA_ROOT, "audio-previews");

/** `{uploads}/audio-tts/{userId}/{jobId}.wav` */
export function buildAudioTtsOutputPath(userId: string, jobId: string): string {
  const dir = resolve(AUDIO_DATA_ROOT, "audio-tts", userId);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${jobId}.wav`);
}

/** Subprocess OmniVoice — bỏ cache HF kế thừa từ Nest/FLUX; path truyền qua stdin JSON. */
export function buildOmnivoiceSpawnEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of [
    "HF_HOME",
    "HUGGINGFACE_HUB_CACHE",
    "TRANSFORMERS_CACHE",
    "XDG_CACHE_HOME",
    "HF_HUB_DISABLE_SYMLINKS",
    "KITLABS_PYTHON_CACHE_DIR",
    "OMNIVOICE_CACHE_ROOT",
  ]) {
    delete env[key];
  }
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

export function resolveAudioPythonBin(): string {
  return (
    process.env.AUDIO_PYTHON_BIN ??
    process.env.TRANSLATE_PYTHON_BIN ??
    (process.platform === "win32" ? "py" : "python3")
  );
}

export function resolveAudioPythonTimeoutMs(): number {
  return Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600_000);
}

/** BullMQ lock must outlive the Python TTS subprocess (default 30s is too short). */
export function resolveAudioQueueLockDurationMs(): number {
  const explicit = Number(process.env.AUDIO_QUEUE_LOCK_MS ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  return resolveAudioPythonTimeoutMs() + 120_000;
}

/** Voice mẫu pipeline — mặc định trong repo: `tools/video-pipeline/voice`. */
export function resolvePipelineVoiceDir(): string {
  const raw = (process.env.PIPELINE_VOICE_DIR ?? process.env.AUDIO_PIPELINE_VOICE_DIR ?? "").trim();
  if (raw) {
    return resolve(raw);
  }
  return resolve(process.cwd(), VOICE_SAMPLES_DIR);
}

export const AUDIO_MAX_TEXT_CHARS = 2000;
export const AUDIO_DEMO_PREVIEW_TEXT = "Xin chào, tôi là giọng đọc nhân tạo của AutoVietsub.";

/** 1 — workflow/video node; 2 — trang Audio Studio */
export const AUDIO_SOURCE_AUTO = "auto" as const;
export const AUDIO_SOURCE_STUDIO = "studio" as const;
export type AudioSourceType = typeof AUDIO_SOURCE_AUTO | typeof AUDIO_SOURCE_STUDIO;

export function resolveAudioSourceType(raw?: string | null): AudioSourceType | undefined {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === AUDIO_SOURCE_AUTO) return AUDIO_SOURCE_AUTO;
  if (key === AUDIO_SOURCE_STUDIO) return AUDIO_SOURCE_STUDIO;
  return undefined;
}

export type AudioPresetVoice = {
  id: string;
  name: string;
  tags: string[];
  language: "vi" | "en";
  gender: "male" | "female";
  avatar: string;
  /** Filename under VOICE_SAMPLES_DIR (.wav / .mp3). refText must match what is spoken in the clip. */
  refWav: string;
  refText: string;
  /**
   * Ngôn ngữ gửi xuống OmniVoice (khác `language` dùng cho UI / lọc danh sách).
   * Mặc định: `en` → english, còn lại → vietnamese.
   */
  omnivoiceLanguage?: OmnivoiceLanguage;
  /** Câu dùng để render `/preview` (cache WAV). Mặc định: AUDIO_DEMO_PREVIEW_TEXT. */
  previewTtsText?: string;
};

/** Một preset cho mỗi file giọng mẫu trong `VOICE_SAMPLES_DIR` (tránh trùng cùng ref + refText lệch). */
export const AUDIO_PRESET_VOICES: AudioPresetVoice[] = [
  {
    id: "rong-con-vietsub",
    name: "RongConVietsub",
    tags: ["Nữ", "Vietsub", "WAV"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "sample.wav",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "giai-tri",
    name: "Ngọc Huyền ",
    tags: ["Nữ", "Giải trí", "MP3"],
    language: "vi",
    gender: "male",
    avatar: "📰",
    refWav: "sample.mp3",
    refText:
      "Capybara, còn được gọi là chuột lang nước, được mệnh danh là bộ trưởng bộ ngoại giao trong thế giới động vật vì tính cách hiền lành, thân thiện và khả năng hòa đồng. Chúng thường sống hòa bình với các loài động vật khác, kể cả những loài săn mồi, và được yêu thích bởi sự gần gũi, thân thiện với con người.",
  },
  {
    id: "ngoc-my",
    name: "Ngọc My",
    tags: ["Nữ", "Edge TTS", "MP3"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "sample_edge_tts.mp3",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "minh-quan",
    name: "Minh Quân",
    tags: ["Nam", "MP3"],
    language: "vi",
    gender: "male",
    avatar: "👨",
    refWav: "Minh_Quan.mp3",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
];

export const OMNIVOICE_LANGUAGE_OPTIONS = [
  { label: "Việt", value: "vietnamese" },
  { label: "Anh", value: "english" },
  { label: "Hàn", value: "korean" },
  { label: "Nhật", value: "japanese" },
] as const;

export type OmnivoiceLanguage = (typeof OMNIVOICE_LANGUAGE_OPTIONS)[number]["value"];

const OMNIVOICE_LANGUAGE_ALIASES: Record<string, OmnivoiceLanguage> = {
  vietnamese: "vietnamese",
  vi: "vietnamese",
  english: "english",
  en: "english",
  korean: "korean",
  ko: "korean",
  japanese: "japanese",
  ja: "japanese",
};

export function resolveOmnivoiceLanguageValue(raw?: string | null): OmnivoiceLanguage {
  const key = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
  const resolved = OMNIVOICE_LANGUAGE_ALIASES[key];
  if (!resolved) {
    throw new Error(
      `Invalid OmniVoice language: ${raw ?? "(empty)"}. Supported: vietnamese, english, korean, japanese`,
    );
  }
  return resolved;
}

export function findPresetVoice(voiceId: string): AudioPresetVoice | undefined {
  return AUDIO_PRESET_VOICES.find((v) => v.id === voiceId);
}

export function resolveOmnivoiceLanguage(voice: AudioPresetVoice): OmnivoiceLanguage {
  if (voice.omnivoiceLanguage) return voice.omnivoiceLanguage;
  return voice.language === 'en' ? 'english' : 'vietnamese';
}

export function resolvePreviewTtsText(voice: AudioPresetVoice): string {
  return voice.previewTtsText ?? AUDIO_DEMO_PREVIEW_TEXT;
}
