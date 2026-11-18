import { join, resolve } from "path";

import { resolveConfiguredPath } from "../../common/desktop/data-path";

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
  const dataRoot = process.env.KITLABS_DATA_ROOT?.trim();
  if (dataRoot) {
    return resolve(dataRoot, "audio");
  }
  return resolve(process.cwd(), "uploads");
}

export const AUDIO_DATA_ROOT = resolveAudioDataRoot();
export const AUDIO_CLONE_UPLOAD_DIR = join(AUDIO_DATA_ROOT, "audio-clone");
export const AUDIO_PREVIEW_CACHE_DIR = join(AUDIO_DATA_ROOT, "audio-previews");

/**
 * Thư mục xuất WAV khi tạo giọng trên page Voice.
 * Runtime `AUDIO_WORK_ROOT` (đọc lúc generate, không cache lúc boot).
 * Mặc định: `{AUDIO_DATA_ROOT}/audio-tts`.
 */
export function resolveAudioOutputDir(): string {
  const configured = process.env.AUDIO_WORK_ROOT?.trim();
  if (configured) {
    return resolveConfiguredPath(configured, "uploads/audio-tts");
  }
  return join(resolveAudioDataRoot(), "audio-tts");
}

/** @deprecated Dùng resolveAudioOutputDir() — giá trị lúc import module, không theo runtime. */
export const AUDIO_OUTPUT_DIR = join(AUDIO_DATA_ROOT, "audio-tts");

/** Voice mẫu đóng gói cùng BE (`tools/video-pipeline/voice`). */
export function resolveBundledVoiceSamplesDir(): string {
  return resolve(process.cwd(), VOICE_SAMPLES_DIR);
}

/** Voice mẫu pipeline — App: `$KITLABS_DATA_ROOT/voice`; Web: `tools/video-pipeline/voice`. */
export function resolvePipelineVoiceDir(): string {
  const raw = (process.env.PIPELINE_VOICE_DIR ?? process.env.AUDIO_PIPELINE_VOICE_DIR ?? "").trim();
  if (raw) {
    return resolve(raw);
  }
  const dataRoot = process.env.KITLABS_DATA_ROOT?.trim();
  if (dataRoot) {
    return resolve(dataRoot, "voice");
  }
  return resolveBundledVoiceSamplesDir();
}

/** Thứ tự tìm file giọng: clone user → dataRoot/voice → sample đóng gói trong BE. */
export function pipelineVoiceSearchDirs(userId?: string): string[] {
  const dirs: string[] = [];
  const root = resolvePipelineVoiceDir();
  const owner = userId?.trim();
  if (owner) {
    dirs.push(join(root, owner));
  }
  dirs.push(root);
  const bundled = resolveBundledVoiceSamplesDir();
  if (resolve(bundled) !== resolve(root)) {
    dirs.push(bundled);
  }
  return dirs;
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
    refWav: "RongConVietsub.wav",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "giai-tri",
    name: "Ngọc Huyền",
    tags: ["Nữ", "Giải trí", "MP3"],
    language: "vi",
    gender: "male",
    avatar: "📰",
    refWav: "Ngoc_Huyen.mp3",
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
    refWav: "Ngoc_My.mp3",
    refText:
      "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ.",
  },
  {
    id: "nu-ngot-ngao",
    name: "Nữ Ngọt Ngào",
    tags: ["Nữ", "WAV"],
    language: "vi",
    gender: "female",
    avatar: "👩",
    refWav: "Nu_Ngot_Ngao.wav",
    refText:
      "xin chào, tôi là một trợ lí AI có khả năng trò chuyện với bạn bằng giọng nói tự nhiên được phát triển bởi nhóm nón lá. Tôi có thể hổ trợ người khiếm thị đọc sách nói, làm trợ lý ảo, review phim, làm waifu để an ủi bạn và phục vụ nhiều mục đích khác",
  },
  {
    id: "tm-hay",
    name: "TM Hay",
    tags: ["Thuyết minh", "WAV"],
    language: "vi",
    gender: "male",
    avatar: "🎙️",
    refWav: "TM_Hay.wav",
    refText:
      "Cháu thấy cung ấn đường của ông tối sầm, chắc chắn sắp gặp họa đổ máu rồi. Thế này đi, hôm nay là ngày lành tháng tốt, cháu để giá giảm kịch sàn cho ông luôn. Cô bé à, nghe lời ông già này khuyên này, rảnh rỗi thì chăm đọc sách vào. Mấy bài văn vở này xưa như trái đất rồi.",
  },
  {
    id: "minh-quan",
    name: "Minh Quân",
    tags: ["Nam", "WAV"],
    language: "vi",
    gender: "male",
    avatar: "👨",
    refWav: "Minh_Quan.wav",
    refText:
      "Trong tập phát sóng hôm nay, chúng ta sẽ cùng khám phá những bí ẩn chưa từng được tiết lộ đằng sau cuộc chiến khốc liệt này. Trò chơi thực sự bây giờ mới chính thức bắt đầu, và kẻ cười cuối cùng chắc chắn không phải là ngươi đâu!",
  },
  {
    id: "adam-vn",
    name: "Adam",
    tags: ["Nam", "WAV"],
    language: "vi",
    gender: "male",
    avatar: "👨",
    refWav: "Adam_VN.wav",
    refText:
      "Xin chào mọi người! Như bạn đang nghe thấy đấy, tốc độ xử lý của mình cực kỳ nhanh và mượt mà, giúp phản hồi gần như ngay lập tức theo thời gian thực.",
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

/** Tên file cũ → tên file theo catalog (giữ job/setting cũ vẫn resolve được). */
export const LEGACY_PIPELINE_VOICE_FILES: Record<string, string> = {
  "sample.wav": "RongConVietsub.wav",
  "sample.mp3": "Ngoc_Huyen.mp3",
  "sample_edge_tts.mp3": "Ngoc_My.mp3",
};

export function resolvePipelineVoiceFileName(fileName: string): string {
  const raw = String(fileName || "").trim();
  if (!raw) return raw;
  const base = raw.replace(/^.*[/\\]/, "");
  return LEGACY_PIPELINE_VOICE_FILES[base] ?? LEGACY_PIPELINE_VOICE_FILES[base.toLowerCase()] ?? raw;
}

export function resolveOmnivoiceLanguage(voice: AudioPresetVoice): OmnivoiceLanguage {
  if (voice.omnivoiceLanguage) return voice.omnivoiceLanguage;
  return voice.language === 'en' ? 'english' : 'vietnamese';
}

export function resolvePreviewTtsText(voice: AudioPresetVoice): string {
  return voice.previewTtsText ?? AUDIO_DEMO_PREVIEW_TEXT;
}
