import { join, resolve } from "path";

export const VIDEO_PIPELINE_DIR = join("tools", "video-pipeline");
export const VOICE_SAMPLES_DIR = join(VIDEO_PIPELINE_DIR, "voice");

/**
 * Thư mục gốc cho `audio-tts`, `audio-clone`, `audio-previews` (phải ghi được bởi user chạy Nest).
 * Mặc định: `<cwd>/uploads`. Nếu repo không cho mkdir (permission), đặt env đường dẫn tuyệt đối có quyền ghi,
 * ví dụ `AUDIO_DATA_ROOT=/var/tmp/kitools-audio` hoặc `KITLABS_AUDIO_DATA_ROOT` (cùng ý nghĩa).
 */
function resolveAudioDataRoot(): string {
  const raw = (process.env.AUDIO_DATA_ROOT ?? process.env.KITLABS_AUDIO_DATA_ROOT ?? "").trim();
  if (raw) {
    return resolve(raw);
  }
  return resolve(process.cwd(), "uploads");
}

export const AUDIO_DATA_ROOT = resolveAudioDataRoot();
export const AUDIO_CLONE_UPLOAD_DIR = join(AUDIO_DATA_ROOT, "audio-clone");
export const AUDIO_OUTPUT_DIR = join(AUDIO_DATA_ROOT, "audio-tts");
export const AUDIO_PREVIEW_CACHE_DIR = join(AUDIO_DATA_ROOT, "audio-previews");

/**
 * Cache HF/torch OmniVoice — **cùng thư mục** với `auto_vietsub_pro` / `pipeline_cache.py`.
 * Mặc định: `tools/video-pipeline/cache/omnivoice` (không dùng `uploads/python-cache`).
 */
export const OMNIVOICE_CACHE_ROOT = resolve(
  (process.env.OMNIVOICE_CACHE_ROOT ?? process.env.KITLABS_PYTHON_CACHE_DIR ?? "").trim() ||
    join(VIDEO_PIPELINE_DIR, "cache", "omnivoice"),
);

/** @deprecated alias — dùng OMNIVOICE_CACHE_ROOT */
export const KITLABS_PYTHON_CACHE_ROOT = OMNIVOICE_CACHE_ROOT;

export const AUDIO_MAX_TEXT_CHARS = 2000;
export const AUDIO_DEMO_PREVIEW_TEXT = "Xin chào, tôi là giọng đọc nhân tạo của AutoVietsub.";

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
  omnivoiceLanguage?: "english" | "vietnamese";
  /** Câu dùng để render `/preview` (cache WAV). Mặc định: AUDIO_DEMO_PREVIEW_TEXT. */
  previewTtsText?: string;
};

/** Một preset cho mỗi file giọng mẫu trong `VOICE_SAMPLES_DIR` (tránh trùng cùng ref + refText lệch). */
export const AUDIO_PRESET_VOICES: AudioPresetVoice[] = [
  {
    id: "ngoc-huyen",
    name: "Ngọc Huyền",
    tags: ["Nữ", "Miền Bắc", "WAV"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "sample.wav",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "tin-tuc",
    name: "Minh Quân",
    tags: ["Nam", "Tin tức", "MP3"],
    language: "vi",
    gender: "male",
    avatar: "📰",
    refWav: "sample.mp3",
    refText:
      "Tin tức hôm nay có nhiều diễn biến quan trọng. Chúng tôi sẽ cập nhật nhanh và chính xác các sự kiện nổi bật trong ngày.",
  },
  {
    id: "ngoc-my",
    name: "Ngọc My",
    tags: ["Nữ", "Edge TTS", "MP3"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "sample_edge_tts.mp3",
    refText: "Xin chào, chào mừng bạn đến với AutoVietsub. Đây là giọng đọc mẫu tiếng Việt, rõ ràng và tự nhiên.",
  },
];

export function findPresetVoice(voiceId: string): AudioPresetVoice | undefined {
  return AUDIO_PRESET_VOICES.find((v) => v.id === voiceId);
}

export function resolveOmnivoiceLanguage(voice: AudioPresetVoice): "english" | "vietnamese" {
  if (voice.omnivoiceLanguage) return voice.omnivoiceLanguage;
  return voice.language === "en" ? "english" : "vietnamese";
}

export function resolvePreviewTtsText(voice: AudioPresetVoice): string {
  return voice.previewTtsText ?? AUDIO_DEMO_PREVIEW_TEXT;
}
