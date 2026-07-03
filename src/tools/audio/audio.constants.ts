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
