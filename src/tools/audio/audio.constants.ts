import { join } from "path";

export const VIDEO_PIPELINE_DIR = join("tools", "video-pipeline");
export const VOICE_SAMPLES_DIR = join(VIDEO_PIPELINE_DIR, "voice");
export const AUDIO_CLONE_UPLOAD_DIR = join("uploads", "audio-clone");
export const AUDIO_OUTPUT_DIR = join("uploads", "audio-tts");
export const AUDIO_PREVIEW_CACHE_DIR = join("uploads", "audio-previews");

export const AUDIO_MAX_TEXT_CHARS = 2000;
export const AUDIO_DEMO_PREVIEW_TEXT =
  "Xin chào, tôi là giọng đọc nhân tạo của AutoVietsub.";

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
    refText:
      "Xin chào, chào mừng bạn đến với AutoVietsub. Đây là giọng đọc mẫu tiếng Việt, rõ ràng và tự nhiên.",
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
