# Giọng mẫu cho API Audio (`/api/tools/audio/voices`)

Preset OmniVoice đọc file **reference** từ `tools/video-pipeline/voice/` (`VOICE_SAMPLES_DIR` trong `src/tools/audio/audio.constants.ts`).

Hiện có **3 preset**, mỗi preset một file mẫu:

| File | voiceId |
|------|---------|
| `sample.wav` | `ngoc-huyen` |
| `sample.mp3` | `tin-tuc` |
| `sample_edge_tts.mp3` | `ngoc-my` |

File `samples_nu-luu-loat.wav` vẫn có trong thư mục voice nếu pipeline khác cần; API preset không dùng nữa.

Khi đổi clip: sửa **`refText`** trong `audio.constants.ts` cho **khớp đúng lời đọc trong file** (OmniVoice; toàn bộ preset dùng transcript tiếng Việt + `vietnamese` trên CLI).
