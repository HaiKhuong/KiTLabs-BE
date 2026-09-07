# Giọng mẫu cho API Audio (`/api/tools/audio/voices`)

Preset OmniVoice đọc file **reference** từ `tools/video-pipeline/voice/` (`VOICE_SAMPLES_DIR` trong `src/tools/audio/audio.constants.ts`).

Tên file theo tên giọng (ASCII, giống `Minh_Quan.mp3`):

| File | voiceId | Tên |
|------|---------|-----|
| `RongConVietsub.wav` | `rong-con-vietsub` | RongConVietsub |
| `Ngoc_Huyen.mp3` | `giai-tri` | Ngọc Huyền |
| `Ngoc_My.mp3` | `ngoc-my` | Ngọc My |
| `Minh_Quan.mp3` | `minh-quan` | Minh Quân |

File `samples_nu-luu-loat.wav` vẫn có trong thư mục voice nếu pipeline khác cần; API preset không dùng.

Khi đổi clip: sửa **`refText`** trong `audio.constants.ts` cho **khớp đúng lời đọc trong file**.
