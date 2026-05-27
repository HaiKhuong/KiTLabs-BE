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
  /** Filename under tools/video-pipeline/voice/ */
  refWav: string;
  refText: string;
};

export const AUDIO_PRESET_VOICES: AudioPresetVoice[] = [
  {
    id: "manh-dung",
    name: "Mạnh Dũng",
    tags: ["Nam", "Miền Bắc"],
    language: "vi",
    gender: "male",
    avatar: "👨",
    refWav: "sample.wav",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "lan-anh",
    name: "Lan Anh",
    tags: ["Nữ", "Miền Nam"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "samples_nu-luu-loat.wav",
    refText:
      "Xin chào các bạn, đây là giọng đọc mẫu miền Nam, rõ ràng và ấm áp, phù hợp cho nội dung giải trí và kể chuyện.",
  },
  {
    id: "tin-tuc",
    name: "Minh Quân",
    tags: ["Tin tức", "Miền Bắc"],
    language: "vi",
    gender: "male",
    avatar: "📰",
    refWav: "sample.wav",
    refText:
      "Tin tức hôm nay có nhiều diễn biến quan trọng. Chúng tôi sẽ cập nhật nhanh và chính xác các sự kiện nổi bật trong ngày.",
  },
  {
    id: "ke-chuyen",
    name: "Thu Hà",
    tags: ["Kể chuyện", "Miền Trung"],
    language: "vi",
    gender: "female",
    avatar: "📖",
    refWav: "samples_nu-luu-loat.wav",
    refText:
      "Ngày xửa ngày xưa, ở một ngôi làng nhỏ, có câu chuyện kỳ lạ đang chờ được kể lại bằng giọng đọc nhẹ nhàng.",
  },
  {
    id: "sarah",
    name: "Sarah",
    tags: ["Nữ", "US English"],
    language: "en",
    gender: "female",
    avatar: "🇺🇸",
    refWav: "sample_edge_tts.mp3",
    refText: "Hello, welcome to AutoVietsub. This is a sample voice for English narration.",
  },
  {
    id: "james",
    name: "James",
    tags: ["Nam", "UK English"],
    language: "en",
    gender: "male",
    avatar: "🇬🇧",
    refWav: "sample_edge_tts.mp3",
    refText: "Hello, I am an AI voice assistant from AutoVietsub, ready to read your text clearly.",
  },
];

export function findPresetVoice(voiceId: string): AudioPresetVoice | undefined {
  return AUDIO_PRESET_VOICES.find((v) => v.id === voiceId);
}
