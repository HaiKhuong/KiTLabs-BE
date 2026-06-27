import argparse
import json
import math
import os
import re
import shutil
import subprocess
import time
import sys
import traceback
import warnings
from pathlib import Path

# PyTorch (EasyOCR / deps): bỏ cảnh báo RNN weights non-contiguous — spam log khi chạy qua BE.
warnings.filterwarnings(
    "ignore",
    message=r".*RNN module weights are not part of single contiguous chunk.*",
    category=UserWarning,
)
# torchaudio: StreamingMediaDecoder deprecated — spam khi torchaudio.save.
warnings.filterwarnings(
    "ignore",
    message=r".*StreamingMediaDecoder has been deprecated.*",
    category=UserWarning,
)

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

from google import genai
from tqdm import tqdm

from step1_easyocr import configure_step1_easyocr
from step1_easyocr import run as _step1_easyocr_run
from step1_paddleocr import configure_step1_paddleocr
from step1_paddleocr import run as _step1_paddleocr_run
from step2_gemini import (
    configure_step2_gemini,
    step2_translate_srt,
)
from step3_edge import (
    configure_step3_edge,
    prepare_speaker_reference,
    run_edge_tts_mp3_save,
    tts_normalize_vi,
)

# ==============================
# CONFIG
# ==============================

SCRIPT_DIR = Path(__file__).resolve().parent
# Nest spawn: đảm bảo import step3_edge từ thư mục video-pipeline.
_SCRIPT_DIR_STR = str(SCRIPT_DIR)
if _SCRIPT_DIR_STR not in sys.path:
    sys.path.insert(0, _SCRIPT_DIR_STR)

WHISPER_MODEL = "large-v3"
WHISPER_LANGUAGE = "zh"
STEP1_SUBTITLE_SOURCE = "embedded"
GEMINI_MODEL_NAME = "gemini-2.5-flash"
EDGE_TTS_VOICE = "vi-VN-HoaiMyNeural"
EDGE_TTS_RATE = "+30%"
EDGE_TTS_VOLUME = "+10%"
EDGE_TTS_PITCH = "+20Hz"
# Step3 TTS: edge = Microsoft Edge TTS; omnivoice = OmniVoice Vietnamese (pip install omnivoice, GPU khuyến nghị).
STEP3_TTS_ENGINE = "edge"
# OmniVoice (splendor1811/omnivoice-vietnamese): ref_text nên là transcript khớp ref_audio.
OMNIVOICE_MODEL_ID = "k2-fsa/OmniVoice"
OMNIVOICE_REF_WAV = str(SCRIPT_DIR / "voice" / "sample.wav")
OMNIVOICE_REF_TEXT = "Chào bạn, tôi đang thực hiện một thử nghiệm để tạo ra bản sao kỹ thuật số cho giọng nói của mình. Quá trình này đòi hỏi sự rõ ràng, nhịp điệu tự nhiên và một chút cảm xúc trong từng câu chữ."
OMNIVOICE_DEVICE_MAP = ""  # rỗng = tự chọn cuda:0 hoặc cpu
OMNIVOICE_DTYPE = "float16"  # float16 | float32 | bfloat16
OMNIVOICE_LANGUAGE = "vietnamese"
OMNIVOICE_NUM_STEP = 8
OMNIVOICE_GUIDANCE_SCALE = 2.0
OMNIVOICE_SEED = 42  # None = random, số nguyên = deterministic (giúp reproducible + ổn định tone giọng)
OMNIVOICE_NORMALIZE_TEXT = False
OMNIVOICE_TRIM_TRAILING_SILENCE = True
OMNIVOICE_TRAILING_SILENCE_MIN_MS = 120
OMNIVOICE_TRAILING_SILENCE_THRESHOLD_DB = -42
STEP3_AUTO_RATE_ENABLED = True
TRANSLATION_CONTEXT = ""  # Custom translation context for Gemini prompt
STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC = 14.0
STEP3_AUTO_RATE_BONUS_PERCENT = 30
STEP3_RATE_MIN_PERCENT = -50
STEP3_RATE_MAX_PERCENT = 95
STEP3_TTS_REQUEST_SLEEP_MS = 150
# Mỗi request edge-tts (save MP3): 0 = không giới hạn thời gian.
STEP3_TTS_API_TIMEOUT_SEC = 120.0
# Sau TTS_RETRY_MAX lần thử edge-tts vẫn lỗi: "stop" = dừng pipeline; "skip" = thay bằng im lặng và tiếp tục.
STEP3_TTS_MAX_RETRY_ACTION = "stop"
# Ghi/đọc checkpoint segment TTS trong logs/tts_chunks: rerender chỉ gọi edge-tts cho segment chưa xong (tiết kiệm rate).
STEP3_VOICE_RESUME = True
# Hiển thị tqdm progress bar ra stdout/stderr khi chạy qua BE.
# off: giữ log sạch (không có blob/progress control chars), on: show progress bar.
PROCESSBAR_LOG_ENABLED = False
# Cho TTS tràn vào khoảng lặng trước câu phụ đề kế (tới next_start) để tránh cắt cụt giữa câu.
STEP3_TTS_BORROW_GAP = False
# Optional: set absolute ffmpeg.exe path here if needed.
FFMPEG_PATH = ""

_DEFAULT_WORK_OUTPUT_ROOT = "/mnt/c/Users/haikh/Videos/VideoVietsub/videos"


def _resolve_work_root_env(var_name: str, fallback: str) -> Path:
    raw = (os.getenv(var_name) or "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return Path(fallback).expanduser().resolve()


# Kết quả cuối (deliverables) — logic cũ, thường /mnt/c trên WSL.
WORK_OUTPUT_ROOT = _resolve_work_root_env("TRANSLATE_WORK_ROOT", _DEFAULT_WORK_OUTPUT_ROOT)
# Workspace xử lý (log, file tạm) — WSL: đặt /home/... để tránh /mnt/c.
WORK_STAGING_ROOT = _resolve_work_root_env(
    "TRANSLATE_WORK_STAGING_ROOT",
    os.getenv("TRANSLATE_WORK_ROOT") or _DEFAULT_WORK_OUTPUT_ROOT,
)

WORK_NAME = "default"
WORK_OUTPUT_DIR = WORK_OUTPUT_ROOT / WORK_NAME
WORK_STAGING_DIR = WORK_STAGING_ROOT / WORK_NAME
WORK_DIR = WORK_STAGING_DIR
VIDEO_DIR = WORK_STAGING_DIR / "videos"
SUBTITLE_DIR = WORK_STAGING_DIR / "subtitles"
LOG_DIR = WORK_STAGING_DIR / "logs"
LOG_PATH = LOG_DIR / "pipeline.log"
# Thư mục ngoài chứa SRT có sẵn ({work_name}.srt) — CLI --existing-srt-dir-path
EXISTING_SRT_DIR_PATH = ""
TRANSLATE_BATCH_SIZE = 500
TTS_CHUNK_MAX_CHARS = 350
RETRY_MAX = 4
# Step 2 Gemini: không retry khi lỗi (một lần gọi thất bại là dừng batch đó).
GEMINI_RETRY_MAX = 1
# Step 2 Gemini: on = thử xoay qua tất cả key khi lỗi; off = chỉ dùng key đang active.
STEP2_MULTI_KEYS_ENABLED = True
TTS_RETRY_MAX = 10
FFMPEG_BIN = None
FFPROBE_BIN = None
SKIP_VOICE_STEP = False
SUBTITLE_FONT = "Arial"
SUBTITLE_FONTSIZE = 16
SUBTITLE_PRIMARY_COLOUR = "&H00FFFFFF"
SUBTITLE_OUTLINE_COLOUR = "&H00000000"
SUBTITLE_OUTLINE = 2
SUBTITLE_SHADOW = 2
SUBTITLE_ALIGNMENT = 2
SUBTITLE_MARGIN_V = 30
SUBTITLE_UPPERCASE = False
SUBTITLE_BG_BLUR_WIDTH_RATIO = 0.70
SUBTITLE_BG_BLUR_HEIGHT = 120
SUBTITLE_BG_BLUR_BOTTOM_OFFSET = 200
SUBTITLE_BG_BLUR_LUMA_RADIUS = 8
SUBTITLE_BG_BLUR_LUMA_POWER = 2
SUBTITLE_BG_BLUR_CHROMA_RADIUS = 4
SUBTITLE_BG_BLUR_CHROMA_POWER = 2
LOGO_FILE = "logo/van_gioi_vietsub_logo.png"
LOGO_WIDTH = 250
LOGO_MARGIN_X = 30
LOGO_MARGIN_Y = 30
LOGO_OPACITY = 0.5
# Step 6: tắt overlay logo (--logo-enabled off) dù vẫn có file --logo-file.
LOGO_ENABLED = True
# Step 7: ghép clip outro sau video _vs_tm (tạo thêm *_vs_tm_outro.mp4).
MERGE_OUTRO_ENABLED = False
OUTRO_FILE = ""
# Step 6: optional visual pass before subtitle (hflip, zoom, eq, unsharp). Bật bằng --step6-visual-transform on.
STEP6_VISUAL_TRANSFORM_ENABLED = True
STEP6_HFLIP = True
STEP6_ZOOM_PERCENT = 6.0  # 5–7: phóng nhẹ rồi crop giữa để lệch logo góc
STEP6_EQ_SATURATION = 1.0
STEP6_EQ_CONTRAST = 1.00
# ffmpeg unsharp: luma WxH:amount:chroma WxH:amount
STEP6_UNSHARP = "5:5:0.8:3:3:0.0"
ORIGINAL_AUDIO_VOLUME = 0.1
NARRATION_AUDIO_VOLUME = 1
# Step4: tốc độ trước khi merge (1.0 = copy video, không setpts). Đổi tốc 0.97 nên dùng --speed-video ở Step7.
STEP4_MERGE_SPEED = 1.0
# Step0: tốc độ video gốc trước Step1 (1.0 = dùng file input, không tạo *_pre.mp4).
PREPROCESS_SPEED = 1.0
# Step7: sau render phụ đề (_vs_tm), áp dụng setpts + atempo lên file cuối (vd 0.97 = chậm ~3%).
SPEED_VIDEO = 0.97
# Step7: độ phân giải xuất 16:9 — 1080p | 2k | 4k | source (giữ WxH sau Step6).
EXPORT_RESOLUTION = "source"
EXPORT_RESOLUTION_PRESETS = {
    "1080p": (1920, 1080),
    "2k": (2560, 1440),
    "4k": (3840, 2160),
}
# Video encode: h264 (mặc định) | hevc — GPU: h264_nvenc / hevc_nvenc, CPU: libx264 / libx265.
VIDEO_CODEC = "h264"


def _normalize_video_codec_key(raw=None):
    key = str(raw if raw is not None else VIDEO_CODEC).strip().lower()
    if key in ("hevc", "h265", "h.265"):
        return "hevc"
    return "h264"


def ffmpeg_video_encode_args(use_gpu):
    """Tham số -c:v + preset/cq|crf; ưu tiên NVENC khi use_gpu=True."""
    codec = _normalize_video_codec_key()
    if codec == "hevc":
        if use_gpu:
            return ["-c:v", "hevc_nvenc", "-preset", "p4", "-cq", "23"]
        return ["-c:v", "libx265", "-preset", "medium", "-crf", "23"]
    if use_gpu:
        return ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]
    return ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
# Xuất MP4: xóa metadata nguồn (-map_metadata -1) và ghi Title/Artist/Comment kênh. Bật: --output-metadata on.
OUTPUT_METADATA_ENABLED = True
# True: title/artist/comment = stem file đầu ra (vd. Ten_vs_tm từ Ten_vs_tm.mp4). False: dùng 3 biến bên dưới.
OUTPUT_METADATA_FROM_FILENAME = True
OUTPUT_METADATA_TITLE = "Vạn Giới Vietsub"
OUTPUT_METADATA_ARTIST = "Vạn Giới Vietsub"
OUTPUT_METADATA_COMMENT = "Vạn Giới Vietsub"

STEP1_VAD_FILTER = True  # Nếu False thì sẽ không dùng các ngưỡng VAD/Whisper phía dưới
# Whisper/VAD: ngưỡng theo --mode basic|advance (STEP1_PROFILES). Không còn override qua CLI.
STEP1_VAD_THRESHOLD = 0.35  # Silero: xác suất tối thiểu để coi là speech (thấp hơn = nhạy hơn với giọng yếu).
STEP1_MIN_SILENCE_MS = (
    400  # im lặng tối thiểu (ms) để tách segment VAD (cao = ít tách hơn).
)
STEP1_MIN_SPEECH_MS = 280  # speech tối thiểu (ms); giảm để không nuốt câu ngắn/nói nhỏ.
STEP1_SPEECH_PAD_MS = (
    320  # lề trước/sau mỗi đoạn speech (ms); tăng giúp bắt đầu/cuối câu nhỏ.
)

STEP1_NO_SPEECH_THRESHOLD = 0.78  # Whisper: chỉ lọc “no speech” khi prob rất cao (cao hơn = giữ nhiều đoạn yếu hơn).
STEP1_LOGPROB_THRESHOLD = (
    -2.0
)  # Whisper: avg logprob; âm hơn = chấp nhận đoạn tin cậy thấp hơn (ít cắt hơn).
STEP1_CONDITION_ON_PREVIOUS_TEXT = (
    False  # True có thể ổn định câu liền kề nhưng dễ lan lỗi sang đoạn sau.
)

# EasyOCR config (STEP1_SUBTITLE_SOURCE = "easyocr")
EASYOCR_LANG = ["ch_sim", "en"]  # EasyOCR language codes
# Giới hạn cao nhất của dải phụ đề (% từ đáy frame); phụ đề thường ≤ 20% từ đáy.
EASYOCR_SUBTITLE_CROP_BAND_HI = 0.20
# Số frame mẫu để detect bbox phụ đề (scan full-frame → OCR → lấy lo/hi từ bbox chữ).
EASYOCR_CROP_PROBE_FRAMES = 12
# Crop ngang (probe + cropped.mp4 Step1): bỏ mé trái/phải trước khi OCR.
EASYOCR_CROP_PROBE_H_TRIM_LEFT_FRAC = 0.15
EASYOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC = 0.15
# Khi không override --easyocr-fps: FPS = 1000 / EASYOCR_MIN_DURATION_MS (lưới thời gian trùng bước min cue).
EASYOCR_FPS = 2  # mặc định đồng bộ với EASYOCR_MIN_DURATION_MS = 500
EASYOCR_WORKERS = 4  # parallel OCR threads
EASYOCR_MIN_CONFIDENCE = 0.5  # discard OCR results below this confidence
EASYOCR_LOW_CONF_FLOOR = 0.003  # ngưỡng tối thiểu để xem xét rescue (dưới mức này bỏ hoàn toàn)
EASYOCR_BRIDGE_FRAMES = 8  # số frame lân cận để vote trong rescue cluster
EASYOCR_BRIDGE_MIN_MATCH = 3  # số frame tương đồng tối thiểu để rescue 1 frame low-conf
EASYOCR_FUZZY_THRESHOLD = 55  # % similarity threshold for dedup/merge
EASYOCR_MIN_DURATION_MS = 500  # minimum SRT cue (ms); đồng thời quyết định bước lấy mẫu OCR nếu không truyền --easyocr-fps
EASYOCR_MERGE_GAP_MS = 200  # merge adjacent similar blocks within this gap (ms)
EASYOCR_GPU = True
# Sau crop dải đáy: grayscale + ffmpeg eq (cùng tham số cho probe-score OpenCV).
# brightness âm (vd -0.06 … -0.12) làm tối, thường giúp giảm dính watermark/logo sáng; gamma>1 tối midtone.
EASYOCR_GRAY_CONTRAST = 2.0
EASYOCR_GRAY_BRIGHTNESS = -0.15
EASYOCR_GRAY_GAMMA = 1.2
# Luma suppression trước khi trích frame OCR (0 = tắt, 1.0 = Y=0 hoàn toàn — chỉ còn chênh lệch màu Cb/Cr).
# Khi > 0: giữ màu RGB (bỏ format=gray), đè Y xuống thấp trong YUV, chuyển về RGB → EasyOCR nhận ảnh màu.
EASYOCR_LUMA_SUPPRESS = 0.0
# White extraction threshold (0 = tắt). Khi > 0: ảnh grayscale → pixel >= thresh thành trắng, còn lại thành đen.
# Cho ra ảnh nhị phân: chữ trắng thành trắng, nền về đen hoàn toàn → EasyOCR đọc rất chính xác.
# Ưu tiên cao hơn luma_suppress. Khuyến nghị: 160..200. Chỉ áp cho cropped.mp4, không probe.
EASYOCR_WHITE_THRESH = 0
# Sau format=gray,eq=…: làm phẳng nền / tách chữ (0 = tắt). Đồng bộ probe OpenCV.
EASYOCR_HISTEQ_STRENGTH = 0.0  # 0..1 → ffmpeg histeq=strength=…; OpenCV blend equalizeHist
EASYOCR_GRAY_INVERT = False  # negate luma (thử với chữ trắng nền tối)
# Chuỗi tham số ffmpeg unsharp (không gồm tiền tố "unsharp="), vd 5:5:0.85:5:5:0.0 — rỗng = tắt
EASYOCR_UNSHARP = ""
# Giới hạn độ cao dải OCR (hi−lo) so với chiều cao khung; 0 = không chặn (vd 0.05 = tối đa 5%).
EASYOCR_MAX_STRIP_HEIGHT_RATIO = 0.05
# Bỏ qua block SRT sau merge nếu fullmatch regex (sau clean_text).
# Các builtin patterns được định nghĩa trong step1_easyocr.py::BUILTIN_SKIP_REGEXES.
EASYOCR_TEXT_SKIP_DEFAULTS_ON = True
EASYOCR_TEXT_SKIP_REGEXES_JSON = "[]"
# Sau Step7: xóa LOG_DIR/step1_ocr (gồm frame_ocr_raw.jsonl debug OCR theo frame) và easyocr_crop_probe; off để giữ.
EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 = True

# PaddleOCR config (STEP1_SUBTITLE_SOURCE = "paddleocr")
PADDLEOCR_LANG = "ch"               # "ch" = Chinese+English unified (PP-OCRv6); "en", "japan", v.v.
PADDLEOCR_USE_GPU = True
PADDLEOCR_USE_ANGLE_CLS = True      # nhận diện sub bị xoay/ngược
PADDLEOCR_MIN_CONFIDENCE = 0.5      # loại bỏ kết quả dưới ngưỡng
PADDLEOCR_LOW_CONF_FLOOR = 0.003    # ngưỡng tối thiểu để xem xét rescue cluster
PADDLEOCR_BATCH_SIZE = 8            # số frame gộp 1 lần gọi batch inference
PADDLEOCR_SUBTITLE_CROP_BAND_HI = 0.20  # giới hạn cao nhất dải phụ đề (% từ đáy)
PADDLEOCR_CROP_PROBE_FRAMES = 12    # số frame mẫu để auto-detect crop band
PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC = 0.15   # bỏ mé trái trước khi OCR
PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC = 0.15  # bỏ mé phải trước khi OCR
PADDLEOCR_MAX_STRIP_HEIGHT_RATIO = 0.05  # giới hạn độ cao dải OCR (0 = không chặn)
PADDLEOCR_MIN_DURATION_MS = 500     # thời gian hiển thị tối thiểu mỗi cue SRT
PADDLEOCR_MERGE_GAP_MS = 200        # merge các block gần nhau trong ngưỡng này (ms)
PADDLEOCR_FUZZY_THRESHOLD = 55      # % similarity để gộp / dedup block
PADDLEOCR_BRIDGE_FRAMES = 8         # số frame lân cận để vote rescue cluster
PADDLEOCR_BRIDGE_MIN_MATCH = 3      # số frame tương đồng tối thiểu để rescue
# Frame Difference: Module 1 – chỉ OCR khi subtitle thực sự thay đổi.
PADDLEOCR_SCAN_FPS = 10             # FPS quét change detection (nên cao hơn tốc độ sub thay đổi)
PADDLEOCR_FRAMEDIFF_THRESHOLD = 8.0 # MAD pixel (0-255); ~8 = thay đổi sub, ~2 = nhiễu nén
PADDLEOCR_FRAMEDIFF_SKIP_BLANK = True  # bỏ qua frame trống (nền đen/trắng không có chữ)
# Preprocessing frame (giống EasyOCR nhưng config độc lập để tuning riêng)
PADDLEOCR_GRAY_CONTRAST = 2.0       # eq contrast
PADDLEOCR_GRAY_BRIGHTNESS = -0.15   # eq brightness (âm = làm tối; giúp giảm logo sáng)
PADDLEOCR_GRAY_GAMMA = 1.2          # eq gamma (>1 tối midtone)
PADDLEOCR_WHITE_THRESH = 0          # 0=tắt; >0: binarize chữ trắng→255, nền→0 (160..200)
PADDLEOCR_LUMA_SUPPRESS = 0.0       # 0=tắt; >0: giữ màu Cb/Cr, đè Y trong YUV
PADDLEOCR_HISTEQ_STRENGTH = 0.0     # 0=tắt; 0..1 → histeq=strength=…
PADDLEOCR_GRAY_INVERT = False       # negate luma (thử với chữ trắng nền tối)
PADDLEOCR_UNSHARP = ""              # vd "5:5:0.85:5:5:0.0" — rỗng = tắt
PADDLEOCR_CLEANUP_DEBUG_AFTER_STEP7 = True  # xóa LOG_DIR/step1_paddleocr sau Step7
# Watermark filter (PaddleOCR)
PADDLEOCR_WATERMARK_BLACKLIST = "腾讯视频,优酷,爱奇艺,芒果TV,bilibili,VIP,独播,搜狐视频,乐视,PP视频,咪咕视频"
PADDLEOCR_WATERMARK_MIN_FRAMES = 0  # 0=auto (80% of total scanned frames); >0=fixed threshold

STEP1_MAX_SUBTITLE_CHARS = 22  # số ký tự tối đa mỗi câu sau tách.
STEP1_MIN_SUBTITLE_DURATION_MS = 280  # thời gian hiển thị tối thiểu mỗi câu.
STEP1_SHORT_TEXT_MAX_CHARS = 14  # ngưỡng để coi là “câu ngắn”.
STEP1_MIN_CHARS_PER_SEC = (
    2.2  # nếu cps thấp hơn ngưỡng, coi là câu ngắn bị dính khoảng trống.
)
STEP1_TARGET_CHARS_PER_SEC = (
    5.5  # tốc độ mục tiêu khi siết lại timing câu ngắn (giữ đuôi, cắt đầu).
)

# Step1 VAD/Whisper presets theo --mode basic|advance (không override từng tham số qua CLI).
STEP1_PROFILES = {
    "basic": {
        "vad_threshold": 0.35,
        "min_silence_ms": 400,
        "min_speech_ms": 280,
        "speech_pad_ms": 320,
        "no_speech_threshold": 0.78,
        "logprob_threshold": -2.0,
        "condition_on_previous_text": False,
    },
    "advance": {
        "vad_threshold": 0.45,
        "min_silence_ms": 500,
        "min_speech_ms": 500,
        "speech_pad_ms": 320,
        "no_speech_threshold": 0.6,
        "logprob_threshold": -1.5,
        "condition_on_previous_text": False,
    },
}


def _load_env_files():
    """Load .env: video-pipeline, tools/, KiTLabs-BE repo root, then cwd (override=False: first wins per key)."""
    if not load_dotenv:
        return
    here = Path(__file__).resolve().parent
    repo_root = here.parents[
        1
    ]  # .../KiTLabs-BE when script is at .../tools/video-pipeline/
    for env_path in (
        here / ".env",
        here.parent / ".env",
        repo_root / ".env",
        Path.cwd() / ".env",
    ):
        if env_path.is_file():
            load_dotenv(env_path, override=False)


_load_env_files()


def parse_api_keys(raw_value):
    if not raw_value:
        return []
    parts = [
        p.strip() for p in re.split(r"[,\n;]+", str(raw_value)) if p and str(p).strip()
    ]
    # Deduplicate while preserving order.
    return list(dict.fromkeys(parts))


_raw_gemini_api_keys = []
_raw_gemini_api_keys.extend(parse_api_keys(os.environ.get("GEMINI_API_KEY")))
_raw_gemini_api_keys.extend(parse_api_keys(os.environ.get("GOOGLE_API_KEY")))
GEMINI_API_KEYS = list(dict.fromkeys(_raw_gemini_api_keys))
GEMINI_CLIENTS = [genai.Client(api_key=api_key) for api_key in GEMINI_API_KEYS]
ACTIVE_GEMINI_KEY_INDEX = 0


def mask_secret(secret, show_prefix=4, show_suffix=4):
    raw = str(secret or "")
    if not raw:
        return ""
    if len(raw) <= show_prefix + show_suffix:
        return "*" * len(raw)
    return f"{raw[:show_prefix]}***{raw[-show_suffix:]}"


# ==============================
# HELPER
# ==============================


def log(message, *, write_file=True):
    if write_file:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
        with open(LOG_PATH, "a", encoding="utf8") as f:
            f.write(line + "\n")
    try:
        print(message)
    except UnicodeEncodeError:
        # Windows console may use a non-Unicode code page (charmap), so fallback safely.
        out = getattr(sys.stdout, "buffer", None)
        if out is not None:
            encoding = getattr(sys.stdout, "encoding", None) or "utf-8"
            out.write((str(message) + "\n").encode(encoding, errors="replace"))
            out.flush()
        else:
            print(str(message).encode("ascii", errors="replace").decode("ascii"))


def progressbar(iterable, **kwargs):
    kwargs.setdefault("disable", not PROCESSBAR_LOG_ENABLED)
    return tqdm(iterable, **kwargs)


def file_ready(path):
    p = Path(path)
    return p.exists() and p.stat().st_size > 0


def retry_call(fn, label, max_retry=RETRY_MAX, base_delay=1.5):
    for attempt in range(1, max_retry + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == max_retry:
                log(f"{label}: failed after {max_retry} attempts: {e}")
                raise RuntimeError(
                    f"{label} failed after {max_retry} attempts: {e}"
                ) from e
            delay = base_delay
            time.sleep(delay)


def step3_tts_retry(
    run_fn, label, max_retry=TTS_RETRY_MAX, base_delay=1.5
):
    """Chạy TTS với retry. Trả về True nếu thành công; False nếu hết retry và STEP3_TTS_MAX_RETRY_ACTION=='skip'."""
    for attempt in range(1, max_retry + 1):
        try:
            run_fn()
            return True
        except Exception as e:
            if attempt == max_retry:
                log(f"Step3 TTS: failed after {max_retry} attempts: {e}")
                if STEP3_TTS_MAX_RETRY_ACTION == "skip":
                    log("Step3 TTS: skip segment (exhausted retries, action=skip).")
                    return False
                raise RuntimeError(
                    f"{label} failed after {max_retry} attempts: {e}"
                ) from e
            delay = base_delay
            time.sleep(delay)


def _write_step3_silent_wav(path, duration_ms, label):
    sec = max(0.001, duration_ms / 1000.0)
    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "anullsrc=r=24000:cl=mono",
            "-t",
            f"{sec:.3f}",
            "-c:a",
            "pcm_s16le",
            str(path),
        ],
        label,
    )


def run_command(args, label):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"{label} failed (code {result.returncode}): {stderr}")
    return result


def get_media_duration_ms(path):
    if not FFPROBE_BIN:
        return None
    try:
        result = run_command(
            [
                str(FFPROBE_BIN),
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            f"Probe duration for {path}",
        )
        duration_seconds = float((result.stdout or "").strip())
        if duration_seconds <= 0:
            return None
        return int(duration_seconds * 1000)
    except Exception as e:
        log(f"Warning: could not probe media duration for {path}: {e}")
        return None


def get_ffprobe_video_dimensions(path):
    """Kích thước WxH (pixel đã giải mã) của video stream đầu tiên (None nếu không probe được).

    Dùng cho zoom Step6: FFmpeg không có filter “zoom” tĩnh chuẩn; scale+crop cần W/H nguyên chính xác
    (tránh lệch giữa HD / Full HD / 2K khi dùng biểu thức iw/zf).
    """
    if not FFPROBE_BIN:
        return None
    try:
        result = subprocess.run(
            [
                str(FFPROBE_BIN),
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height",
                "-of",
                "csv=p=0:s=x",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode != 0:
            return None
        first = (result.stdout or "").strip().splitlines()
        if not first:
            return None
        parts = first[0].strip().split("x")
        if len(parts) != 2:
            return None
        w, h = int(parts[0]), int(parts[1])
        if w <= 1 or h <= 1:
            return None
        return (w, h)
    except Exception as e:
        log(f"Warning: ffprobe WxH failed for {path}: {e}")
        return None


def _step6_zoom_scale_crop_literal_dims(ow, oh, zf):
    """Zoom tĩnh (phóng rồi crop giữa): trả về scale_w, scale_h, crop_x, crop_y, out_w, out_h.

    - out_w/out_h = ow/oh (giữ nguyên kích thước đầu ra).
    - scale_* = số chẵn >= nguồn * zf (yuv420 / swscale thân thiện).
    - crop_x/crop_y chẵn để tránh lệch chroma 4:2:0.
    """
    ow = int(ow)
    oh = int(oh)
    # yuv420p / H.264: crop ra lẻ dễ lỗi encoder; căn chỉnh theo lưới 2 px (giữ gần nguồn).
    ow &= ~1
    oh &= ~1
    zf = float(zf)
    if ow <= 1 or oh <= 1 or zf <= 1.0 + 1e-9:
        return None

    def smallest_even_not_below(x):
        return max(2, int(math.ceil(float(x) / 2.0)) * 2)

    scaled_w = max(ow, smallest_even_not_below(ow * zf))
    scaled_h = max(oh, smallest_even_not_below(oh * zf))
    cx = ((scaled_w - ow) // 2) & ~1
    cy = ((scaled_h - oh) // 2) & ~1
    while cx + ow > scaled_w:
        scaled_w += 2
    while cy + oh > scaled_h:
        scaled_h += 2
    return scaled_w, scaled_h, cx, cy, ow, oh


def build_atempo_filter(speed_factor):
    # ffmpeg atempo only supports each stage in [0.5, 2.0],
    # so chain multiple stages when speed-up is greater than 2x.
    factor = max(float(speed_factor), 0.5)
    stages = []
    while factor > 2.0:
        stages.append("atempo=2.0")
        factor /= 2.0
    stages.append(f"atempo={factor:.6f}")
    return ",".join(stages)


def media_has_audio_stream(path):
    """True if the file has at least one audio stream (uses ffmpeg -i probe)."""
    result = subprocess.run(
        [FFMPEG_BIN, "-hide_banner", "-i", str(path)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    combined = (result.stderr or "") + (result.stdout or "")
    # e.g. "Stream #0:1[0x101](und): Audio: aac" — allow optional [0x..] before (lang).
    return bool(
        re.search(
            r"Stream\s+#\d+:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?:\s*Audio:",
            combined,
        )
    )


def resolve_ffmpeg_binary():
    candidates = []
    if FFMPEG_PATH:
        candidates.append(Path(FFMPEG_PATH))

    which_path = shutil.which("ffmpeg")
    if which_path:
        candidates.append(Path(which_path))

    localappdata = os.getenv("LOCALAPPDATA", "")
    if localappdata:
        winget_root = Path(localappdata) / "Microsoft" / "WinGet" / "Packages"
        if winget_root.exists():
            for pkg_dir in sorted(winget_root.glob("Gyan.FFmpeg*"), reverse=True):
                candidates.extend(sorted(pkg_dir.glob("**/ffmpeg.exe"), reverse=True))

    candidates.extend(
        [
            Path(r"C:\ffmpeg\bin\ffmpeg.exe"),
            Path(r"C:\ProgramData\chocolatey\bin\ffmpeg.exe"),
            Path.home()
            / "scoop"
            / "apps"
            / "ffmpeg"
            / "current"
            / "bin"
            / "ffmpeg.exe",
        ]
    )

    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    return None


def resolve_ffprobe_binary():
    candidates = []
    if FFMPEG_BIN:
        ffmpeg_path = Path(FFMPEG_BIN)
        candidates.append(ffmpeg_path.with_name("ffprobe.exe"))
        candidates.append(ffmpeg_path.with_name("ffprobe"))

    for name in ("ffprobe", "ffprobe.exe"):
        which_path = shutil.which(name)
        if which_path:
            candidates.append(Path(which_path))

    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    return None


def preflight_checks():
    global FFMPEG_BIN
    global FFPROBE_BIN
    if not GEMINI_CLIENTS:
        raise EnvironmentError(
            "Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env or the environment."
        )
    FFMPEG_BIN = resolve_ffmpeg_binary()
    if FFMPEG_BIN is None:
        raise EnvironmentError(
            "ffmpeg not found. Add it to PATH or set FFMPEG_PATH in script config."
        )
    run_command([FFMPEG_BIN, "-version"], "ffmpeg check")
    FFPROBE_BIN = resolve_ffprobe_binary()
    if FFPROBE_BIN:
        run_command([FFPROBE_BIN, "-version"], "ffprobe check")
    else:
        log(
            "Warning: ffprobe not found. Some duration/subtitle probe features may be unavailable."
        )
    configure_step2_gemini(
        log=log,
        write_text=write_text,
        append_text=append_text,
        parse_srt=parse_srt,
        write_srt=write_srt,
        progressbar=progressbar,
        retry_call=retry_call,
        get_vi_srt_path=get_vi_srt_path,
        log_dir=LOG_DIR,
        gemini_api_keys=GEMINI_API_KEYS,
        gemini_model_name=GEMINI_MODEL_NAME,
        gemini_retry_max=GEMINI_RETRY_MAX,
        translate_batch_size=TRANSLATE_BATCH_SIZE,
        translation_context=TRANSLATION_CONTEXT,
        step2_multi_keys_enabled=STEP2_MULTI_KEYS_ENABLED,
    )
    log(
        f"Preflight OK (Gemini keys={len(GEMINI_API_KEYS)}, ffmpeg+ffprobe ready)."
    )


def fmt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def srt_time_to_ms(time_str):
    hms, ms = time_str.strip().split(",")
    h, m, s = hms.split(":")
    return int(h) * 3600000 + int(m) * 60000 + int(s) * 1000 + int(ms)


def parse_srt_time_range(time_range):
    start_str, end_str = [x.strip() for x in time_range.split("-->")]
    return srt_time_to_ms(start_str), srt_time_to_ms(end_str)


def parse_srt(srt_text):
    blocks = []
    chunks = re.split(r"\n\s*\n", srt_text.strip(), flags=re.MULTILINE)
    for chunk in chunks:
        lines = [line.rstrip("\n") for line in chunk.splitlines() if line.strip() != ""]
        if len(lines) < 3:
            continue
        if not lines[0].strip().isdigit() or "-->" not in lines[1]:
            continue
        blocks.append(
            {
                "index": int(lines[0].strip()),
                "time": lines[1].strip(),
                "text": "\n".join(lines[2:]).strip(),
            }
        )
    return blocks


def write_srt(blocks, out_path):
    with open(out_path, "w", encoding="utf8") as f:
        for b in blocks:
            f.write(f"{b['index']}\n")
            f.write(f"{b['time']}\n")
            f.write(f"{str(b['text'])}\n\n")


def chunk_text_for_tts(text, max_chars=TTS_CHUNK_MAX_CHARS):
    parts = []
    current = []
    current_len = 0
    for paragraph in [p.strip() for p in text.splitlines() if p.strip()]:
        if len(paragraph) > max_chars:
            sentences = re.split(r"(?<=[.!?])\s+", paragraph)
        else:
            sentences = [paragraph]
        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            if current_len + len(sentence) + 1 > max_chars and current:
                parts.append(" ".join(current).strip())
                current = [sentence]
                current_len = len(sentence)
            else:
                current.append(sentence)
                current_len += len(sentence) + 1
    if current:
        parts.append(" ".join(current).strip())
    return parts


def sanitize_tts_text(text):
    """Normalize subtitle text before sending to edge-tts."""
    raw = str(text or "")
    # Normalize line breaks/tabs and collapse repeated spaces.
    cleaned = raw.replace("\r", " ").replace("\n", " ").replace("\t", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    # Strip common invisible/control chars that can make TTS return no audio.
    cleaned = re.sub(r"[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "", cleaned)
    cleaned = cleaned.replace("\u200b", "").replace("\ufeff", "").strip()
    return cleaned


def make_text_preview(text, max_len=80):
    compact = re.sub(r"\s+", " ", str(text or "")).strip()
    if len(compact) <= max_len:
        return compact
    return compact[: max_len - 3] + "..."


def parse_percent_string(value, default_value=0.0):
    raw = str(value or "").strip()
    matched = re.match(r"^([+-]?\d+(?:\.\d+)?)%$", raw)
    if not matched:
        return float(default_value)
    return float(matched.group(1))


def format_percent_string(value):
    rounded = int(round(float(value)))
    return f"{'+' if rounded >= 0 else ''}{rounded}%"


def resolve_base_tts_rate(raw_rate):
    default_rate = "+60%"
    raw = str(raw_rate or "").strip()
    if not raw:
        return default_rate

    matched = re.match(r"^([+-]?\d+(?:\.\d+)?)%$", raw)
    if matched:
        return format_percent_string(float(matched.group(1)))

    try:
        # Allow plain numeric values like "20" as "+20%".
        return format_percent_string(float(raw))
    except Exception:
        return default_rate


def resolve_dynamic_tts_rate(text, subtitle_duration_ms):
    """Pick edge-tts rate from text density vs slot length.

    STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC is the *target* density: we ramp bonus
    smoothly before/around that value (no hard cliff), and scale bonus up when
    text is much denser than the SRT window — so ffmpeg needs less aggressive
    atempo in Step3.
    """
    base_rate = parse_percent_string(
        resolve_base_tts_rate(EDGE_TTS_RATE), default_value=60.0
    )
    if not STEP3_AUTO_RATE_ENABLED or subtitle_duration_ms <= 0:
        return format_percent_string(base_rate), False

    compact_text = re.sub(r"\s+", "", str(text or ""))
    if not compact_text:
        return format_percent_string(base_rate), False

    duration_sec = max(subtitle_duration_ms / 1000.0, 0.001)
    chars_per_sec = len(compact_text) / duration_sec
    trigger = float(STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC)
    if trigger <= 0:
        return format_percent_string(base_rate), False

    ratio = chars_per_sec / trigger
    base_bonus = float(STEP3_AUTO_RATE_BONUS_PERCENT)

    # Ease in before trigger (~0.82–1.0) so borderline subtitles don't jump 0→full bonus.
    ramp_start = 0.82
    if ratio <= ramp_start:
        bonus = 0.0
    elif ratio < 1.0:
        t = (ratio - ramp_start) / max(1e-6, (1.0 - ramp_start))
        bonus = base_bonus * t
    else:
        # Above trigger: full base bonus plus extra when text is much denser than the window.
        extra = min(2.0, ratio - 1.0)
        bonus = base_bonus * (1.0 + extra)

    # Step3 logs: only flag noticeable boosts (light ramp near threshold stays quiet).
    log_boost = ratio >= 1.0 or bonus >= base_bonus * 0.45

    final_rate = max(
        float(STEP3_RATE_MIN_PERCENT),
        min(float(STEP3_RATE_MAX_PERCENT), base_rate + bonus),
    )
    return format_percent_string(final_rate), log_boost


def split_subtitle_text(text, max_chars=STEP1_MAX_SUBTITLE_CHARS):
    cleaned = re.sub(r"\s+", " ", str(text or "").strip())
    if not cleaned:
        return []

    # Keep punctuation with each clause to preserve speech rhythm.
    clauses = re.findall(r"[^，。！？；：,.!?;:]+[，。！？；：,.!?;:]?", cleaned)
    if not clauses:
        clauses = [cleaned]

    chunks = []
    current = ""
    for clause in clauses:
        clause = clause.strip()
        if not clause:
            continue
        if len(clause) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            for i in range(0, len(clause), max_chars):
                piece = clause[i : i + max_chars].strip()
                if piece:
                    chunks.append(piece)
            continue

        if not current:
            current = clause
        elif len(current) + len(clause) <= max_chars:
            current = f"{current}{clause}"
        else:
            chunks.append(current)
            current = clause
    if current:
        chunks.append(current)
    return chunks


def split_segment_to_timed_chunks(text, start_sec, end_sec, word_items=None):
    chunks = split_subtitle_text(text)
    if not chunks:
        return []

    start_ms = int(max(start_sec, 0) * 1000)
    end_ms = int(max(end_sec, 0) * 1000)
    if end_ms <= start_ms:
        end_ms = start_ms + STEP1_MIN_SUBTITLE_DURATION_MS

    if len(chunks) == 1:
        return [(start_ms, end_ms, chunks[0])]

    if word_items and len(word_items) >= len(chunks):
        usable_words = [
            (float(w[0]), float(w[1]), str(w[2]).strip())
            for w in word_items
            if w
            and len(w) >= 3
            and w[0] is not None
            and w[1] is not None
            and float(w[1]) > float(w[0])
        ]
        usable_words = [w for w in usable_words if w[2]]
        usable_words.sort(key=lambda x: x[0])

        if len(usable_words) >= len(chunks):
            total_words = len(usable_words)
            total_chunk_chars = sum(max(len(c), 1) for c in chunks)
            remaining_chars = total_chunk_chars
            cursor_word_idx = 0
            timed = []

            for idx, chunk in enumerate(chunks):
                is_last = idx == len(chunks) - 1
                if is_last:
                    next_word_idx = total_words
                else:
                    remaining_words = total_words - cursor_word_idx
                    remaining_chunks = len(chunks) - idx
                    chunk_weight = max(len(chunk), 1)
                    estimated = int(
                        round(
                            (chunk_weight / max(remaining_chars, 1)) * remaining_words
                        )
                    )
                    estimated = max(1, estimated)
                    max_allow = remaining_words - (remaining_chunks - 1)
                    take_words = min(estimated, max_allow)
                    next_word_idx = cursor_word_idx + take_words

                selected = usable_words[cursor_word_idx:next_word_idx]
                if not selected:
                    selected = [usable_words[min(cursor_word_idx, total_words - 1)]]
                    next_word_idx = min(cursor_word_idx + 1, total_words)

                chunk_start = int(selected[0][0] * 1000)
                chunk_end = int(selected[-1][1] * 1000)
                timed.append((chunk_start, chunk_end, chunk))

                cursor_word_idx = next_word_idx
                remaining_chars = max(0, remaining_chars - max(len(chunk), 1))

            min_required = STEP1_MIN_SUBTITLE_DURATION_MS * len(chunks)
            segment_end_bound = max(end_ms, start_ms + min_required)
            fixed = []
            cursor = start_ms
            for idx, (chunk_start, chunk_end, chunk_text) in enumerate(timed):
                remaining_after = len(timed) - idx - 1
                latest_end = (
                    segment_end_bound - STEP1_MIN_SUBTITLE_DURATION_MS * remaining_after
                )
                chunk_start = max(chunk_start, cursor)
                chunk_end = max(chunk_end, chunk_start + STEP1_MIN_SUBTITLE_DURATION_MS)
                chunk_end = min(chunk_end, latest_end)
                if chunk_end <= chunk_start:
                    chunk_end = chunk_start + STEP1_MIN_SUBTITLE_DURATION_MS
                fixed.append((chunk_start, chunk_end, chunk_text))
                cursor = chunk_end
            return fixed

    total_span = end_ms - start_ms
    total_weight = sum(max(len(c), 1) for c in chunks)
    min_required = STEP1_MIN_SUBTITLE_DURATION_MS * len(chunks)
    if total_span < min_required:
        total_span = min_required
        end_ms = start_ms + total_span

    timed = []
    cursor = start_ms
    for idx, chunk in enumerate(chunks):
        if idx == len(chunks) - 1:
            chunk_end = end_ms
        else:
            ratio = max(len(chunk), 1) / total_weight
            duration = max(STEP1_MIN_SUBTITLE_DURATION_MS, int(total_span * ratio))
            chunk_end = min(
                end_ms - STEP1_MIN_SUBTITLE_DURATION_MS * (len(chunks) - idx - 1),
                cursor + duration,
            )
        if chunk_end <= cursor:
            chunk_end = cursor + STEP1_MIN_SUBTITLE_DURATION_MS
        timed.append((cursor, chunk_end, chunk))
        cursor = chunk_end
    return timed


def tighten_sparse_subtitle_timing(start_ms, end_ms, text):
    raw_text = str(text or "")
    compact = re.sub(r"\s+", "", raw_text).strip()
    text_len = len(compact)
    duration_ms = max(int(end_ms) - int(start_ms), 1)

    if text_len == 0:
        return int(start_ms), int(end_ms), False

    duration_sec = duration_ms / 1000.0
    chars_per_sec = text_len / duration_sec
    is_short_text = text_len <= int(STEP1_SHORT_TEXT_MAX_CHARS)
    is_too_sparse = chars_per_sec < float(STEP1_MIN_CHARS_PER_SEC)
    if not (is_short_text and is_too_sparse):
        return int(start_ms), int(end_ms), False

    target_ms = int(
        round((text_len / max(float(STEP1_TARGET_CHARS_PER_SEC), 0.1)) * 1000)
    )
    max_short_ms = int(
        round(
            (
                int(STEP1_SHORT_TEXT_MAX_CHARS)
                / max(float(STEP1_TARGET_CHARS_PER_SEC), 0.1)
            )
            * 1000
        )
    )
    target_ms = min(target_ms, max_short_ms)
    target_ms = max(int(STEP1_MIN_SUBTITLE_DURATION_MS), target_ms)

    # Keep the speech end anchor and trim leading silence.
    # This matches real playback better for short phrases that only occur near segment end.
    tightened_start = max(int(start_ms), int(end_ms) - target_ms)
    if int(end_ms) <= tightened_start:
        tightened_start = int(end_ms) - int(STEP1_MIN_SUBTITLE_DURATION_MS)
    tightened_start = max(0, tightened_start)
    changed = tightened_start > int(start_ms)
    return int(tightened_start), int(end_ms), changed


def extract_json_array(text):
    cleaned = text.strip()
    match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
    if not match:
        raise ValueError("No JSON array found in model output.")
    return json.loads(match.group(0))


def to_ffmpeg_ass_filter_path(path):
    p = Path(path).resolve().as_posix()
    p = p.replace(":", r"\:")
    p = p.replace("'", r"\'")
    return p


def write_text(path, content):
    with open(path, "w", encoding="utf8") as f:
        f.write(content)


def append_text(path, content):
    with open(path, "a", encoding="utf8") as f:
        f.write(content)


def write_ffmpeg_concat_list(paths, out_list_path):
    with open(out_list_path, "w", encoding="utf8") as f:
        for p in paths:
            f.write(f"file '{p.as_posix()}'\n")


def _step3_voice_checkpoint_paths(chunk_dir):
    """JSON: chỉ số block 0-based trong vòng lặp (khớp part_XXXX.wav). TXT: số thứ tự dòng SRT (1-based) đã gen xong."""
    return (
        chunk_dir / f"{WORK_NAME}_voice_segments.json",
        chunk_dir / f"{WORK_NAME}_voice_ok_srt.txt",
    )


def _step3_prune_voice_checkpoint_missing_wavs(done_set, srt_path, chunk_dir, blocks):
    """Bỏ idx nếu thiếu file WAV (user xóa part/empty để gen lại). Cập nhật json/txt nếu có thay đổi."""
    if not done_set:
        return
    removed = []
    for i in list(done_set):
        if i < 0 or i >= len(blocks):
            done_set.discard(i)
            removed.append(i)
            continue
        st = sanitize_tts_text(blocks[i]["text"])
        p = (
            chunk_dir / f"empty_{i:04d}.wav"
            if not st
            else chunk_dir / f"part_{i:04d}.wav"
        )
        if not file_ready(p):
            done_set.discard(i)
            removed.append(i)
    if removed:
        _step3_save_voice_checkpoint(srt_path, chunk_dir, blocks, done_set)


def _step3_load_voice_checkpoint(srt_path, chunk_dir, block_count):
    """Trả về set chỉ số i (enumerate blocks) đã có WAV để bỏ qua bước TTS."""
    json_path, _ = _step3_voice_checkpoint_paths(chunk_dir)
    if not json_path.is_file():
        return set()
    try:
        with open(json_path, encoding="utf8") as f:
            data = json.load(f)
    except Exception:
        return set()
    try:
        sp = str(Path(srt_path).resolve())
        mtime = Path(srt_path).stat().st_mtime
    except OSError:
        return set()
    if str(data.get("srt_path_resolved") or "") != sp:
        return set()
    if abs(float(data.get("srt_mtime", 0)) - mtime) > 0.01:
        return set()
    if int(data.get("block_count", -1)) != int(block_count):
        return set()
    if str(data.get("tts_engine") or "edge") != str(STEP3_TTS_ENGINE):
        return set()
    raw = data.get("done_block_indices") or []
    return {int(x) for x in raw if 0 <= int(x) < block_count}


def _step3_save_voice_checkpoint(srt_path, chunk_dir, blocks, done_indices):
    json_path, txt_path = _step3_voice_checkpoint_paths(chunk_dir)
    try:
        sp = str(Path(srt_path).resolve())
        mtime = Path(srt_path).stat().st_mtime
    except OSError as e:
        log(f"Step3: không ghi checkpoint voice (stat SRT): {e}")
        return
    payload = {
        "version": 1,
        "tts_engine": str(STEP3_TTS_ENGINE or "edge"),
        "srt_path_resolved": sp,
        "srt_mtime": mtime,
        "block_count": len(blocks),
        "done_block_indices": sorted(int(x) for x in done_indices),
    }
    try:
        tmp = json_path.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        tmp.replace(json_path)
    except Exception as e:
        log(f"Step3: không ghi checkpoint voice json: {e}")
    try:
        srt_ok = sorted(
            blocks[i]["index"] for i in sorted(done_indices) if i < len(blocks)
        )
        write_text(txt_path, " ".join(str(x) for x in srt_ok))
    except Exception as e:
        log(f"Step3: không ghi voice_ok_srt.txt: {e}")


def get_zh_srt_path():
    return SUBTITLE_DIR / f"{WORK_NAME}.zh.srt"


def get_vi_srt_path():
    return SUBTITLE_DIR / f"{WORK_NAME}.vi.srt"


def _try_prefetch_step1_zh_srt_from_existing_dir():
    """Nếu --existing-srt-dir-path có {WORK_NAME}.srt thì copy sang subtitles/{WORK_NAME}.zh.srt và bỏ Step1."""
    raw = str(EXISTING_SRT_DIR_PATH or "").strip()
    if not raw:
        return None

    folder = Path(raw).expanduser().resolve()
    if not folder.is_dir():
        log(f"Step1: existing-srt-dir-path không tồn tại, chạy Step1 bình thường: {folder}")
        return None

    source = folder / f"{WORK_NAME}.srt"
    if not file_ready(source):
        log(
            f"Step1: không thấy {source.name} trong existing-srt-dir-path, chạy Step1 bình thường."
        )
        return None

    dest = get_zh_srt_path()
    SUBTITLE_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, dest)
    if not file_ready(dest):
        raise RuntimeError(f"Step1 prefetch copy failed: {source} -> {dest}")

    with open(dest, encoding="utf8") as f:
        blocks = parse_srt(f.read())
    if not blocks:
        raise RuntimeError(f"Step1 prefetch SRT rỗng: {source}")

    log(
        f"Step1: dùng SRT có sẵn từ {source} ({len(blocks)} cues) -> {dest} "
        f"(bỏ qua Whisper/EasyOCR)."
    )
    return dest


def cleanup_step6_intermediate_files():
    targets = [
        LOG_DIR / "step1_input.wav",
        VIDEO_DIR / f"{WORK_NAME}_tm.mp4",
        VIDEO_DIR / f"{WORK_NAME}_voice.wav",
    ]
    for target in targets:
        try:
            if target.exists():
                target.unlink()
                log(f"Cleanup: removed {target}")
        except Exception as e:
            log(f"Cleanup warning: failed to remove {target}: {e}")


def build_subtitle_filter_tail(ass_path):
    """split → blur strip → overlay → ass, output [vsub]. Dùng sau [0:v] hoặc sau chuỗi biến đổi."""
    filter_path = to_ffmpeg_ass_filter_path(ass_path)
    return (
        "split[main][blur];"
        f"[blur]crop=iw*{SUBTITLE_BG_BLUR_WIDTH_RATIO}:{SUBTITLE_BG_BLUR_HEIGHT}:"
        f"(iw-iw*{SUBTITLE_BG_BLUR_WIDTH_RATIO})/2:ih-{SUBTITLE_BG_BLUR_BOTTOM_OFFSET},"
        "boxblur="
        f"{SUBTITLE_BG_BLUR_LUMA_RADIUS}:{SUBTITLE_BG_BLUR_LUMA_POWER}:"
        f"{SUBTITLE_BG_BLUR_CHROMA_RADIUS}:{SUBTITLE_BG_BLUR_CHROMA_POWER}"
        "[blurred];"
        f"[main][blurred]overlay=(W-w)/2:H-{SUBTITLE_BG_BLUR_BOTTOM_OFFSET},"
        f"ass='{filter_path}'[vsub]"
    )


def build_visual_transform_filters(src_wh=None):
    """hflip → scale+crop (zoom ~STEP6_ZOOM_PERCENT%) → eq → unsharp. Chuỗi filter không gồm nhãn [0:v].

    Zoom: FFmpeg chỉ có chuỗi scale+rồi crop giữa; không có “zoom” một lệnh. W/H được tính sẵn từ
    ffprobe (pixel giải mã, giống iw/ih sau decode) để đầu ra luôn đúng WxH — tránh sai số của
    crop=iw/ZF kiểu float trên các mode HD / Full HD / 1440p / 2160p.

    Nếu không probe được WxH khi đang bật zoom → bỏ qua zoom (giữ khung như nguồn), không dùng
    fallback iw*zf đã hay lệch ±1–3 px.
    """
    if not STEP6_VISUAL_TRANSFORM_ENABLED:
        return ""
    parts = []
    if STEP6_HFLIP:
        parts.append("hflip")
    zp = float(STEP6_ZOOM_PERCENT)
    if zp > 0.01:
        zf = 1.0 + zp / 100.0
        applied = False
        if isinstance(src_wh, tuple) and len(src_wh) == 2:
            try:
                dims = _step6_zoom_scale_crop_literal_dims(src_wh[0], src_wh[1], zf)
            except (TypeError, ValueError):
                dims = None
            if dims:
                scaled_w, scaled_h, cx, cy, ow, oh = dims
                parts.append(
                    f"scale={scaled_w}:{scaled_h}:flags=bicubic+accurate_rnd"
                )
                parts.append(f"crop={ow}:{oh}:{cx}:{cy}")
                applied = True
        if not applied:
            if isinstance(src_wh, tuple) and len(src_wh) == 2:
                log("Step6 zoom: không áp được scale+crop an toàn từ WxH — bỏ qua zoom.")
            else:
                log("Step6 zoom: thiếu WxH ffprobe — bỏ qua zoom.")
    parts.append(
        f"eq=saturation={float(STEP6_EQ_SATURATION):.4f}:contrast={float(STEP6_EQ_CONTRAST):.4f}"
    )
    parts.append(f"unsharp={STEP6_UNSHARP}")
    return ",".join(parts)


def build_subtitle_filter(ass_path, src_wh=None):
    tail = build_subtitle_filter_tail(ass_path)
    if not STEP6_VISUAL_TRANSFORM_ENABLED:
        return tail
    vt = build_visual_transform_filters(src_wh)
    if not vt:
        return tail
    return f"[0:v]{vt},{tail}"


def normalize_ass_colour(raw_value):
    value = str(raw_value or "").strip()
    if not value:
        return "&H00FFFFFF"

    # ASS color format: &HAABBGGRR
    # Accept CSS style #RRGGBB / #AARRGGBB and convert to ASS order.
    if value.startswith("#"):
        hex_value = value[1:]
        if len(hex_value) == 6:
            rr = hex_value[0:2]
            gg = hex_value[2:4]
            bb = hex_value[4:6]
            return f"&H00{bb}{gg}{rr}".upper()
        if len(hex_value) == 8:
            aa = hex_value[0:2]
            rr = hex_value[2:4]
            gg = hex_value[4:6]
            bb = hex_value[6:8]
            return f"&H{aa}{bb}{gg}{rr}".upper()
        return "&H00FFFFFF"

    if value.lower().startswith("&h"):
        body = value[2:]
        if len(body) == 6:
            return f"&H00{body}".upper()
        if len(body) == 8:
            return f"&H{body}".upper()
        return "&H00FFFFFF"

    return "&H00FFFFFF"


def _stem_for_mp4_metadata(out_path):
    """Stem hiển thị trong metadata; bỏ hậu tố .part nếu là file tạm ffmpeg (vd. *.mp4.part)."""
    p = Path(out_path)
    if p.suffix.lower() == ".part":
        p = p.with_suffix("")
    return p.stem


def ffmpeg_output_metadata_args(out_path=None):
    """Trước path đầu ra: -map_metadata -1 và các -metadata (title/artist/comment) nếu bật."""
    if not OUTPUT_METADATA_ENABLED:
        return []
    args = ["-map_metadata", "-1"]
    if OUTPUT_METADATA_FROM_FILENAME and out_path is not None:
        base = _stem_for_mp4_metadata(out_path).strip()
        t = a = c = base
    else:
        t = str(OUTPUT_METADATA_TITLE or "").strip()
        a = str(OUTPUT_METADATA_ARTIST or "").strip()
        c = str(OUTPUT_METADATA_COMMENT or "").strip()
    if t:
        args.extend(["-metadata", f"title={t}"])
    if a:
        args.extend(["-metadata", f"artist={a}"])
    if c:
        args.extend(["-metadata", f"comment={c}"])
    return args


def build_step6_render_command(
    video_path, out_path, subtitle_filter, use_gpu, logo_path=None
):
    input_args = ["-i", str(video_path)]
    use_complex = logo_path is not None or STEP6_VISUAL_TRANSFORM_ENABLED
    filter_arg_key = "-filter_complex" if use_complex else "-vf"
    filter_arg_value = subtitle_filter
    map_args = []
    if use_complex and not logo_path:
        map_args = ["-map", "[vsub]", "-map", "0:a?"]

    if logo_path:
        logo_filter = (
            f"[1:v]format=rgba,scale={int(LOGO_WIDTH)}:-1,colorchannelmixer=aa={float(LOGO_OPACITY)}[logo];"
            f"[vsub][logo]overlay={int(LOGO_MARGIN_X)}:{int(LOGO_MARGIN_Y)}[vout]"
        )
        filter_arg_key = "-filter_complex"
        filter_arg_value = f"{subtitle_filter};{logo_filter}"
        input_args.extend(["-i", str(logo_path)])
        map_args = ["-map", "[vout]", "-map", "0:a?"]

    meta = ffmpeg_output_metadata_args(out_path)
    v_enc = ffmpeg_video_encode_args(use_gpu)
    return [
        FFMPEG_BIN,
        "-y",
        *input_args,
        filter_arg_key,
        filter_arg_value,
        *map_args,
        *v_enc,
        "-c:a",
        "copy",
        *meta,
        str(out_path),
    ]


def update_ass_default_style(ass_path):
    with open(ass_path, "r", encoding="utf8") as f:
        lines = f.readlines()

    updated = False
    for idx, line in enumerate(lines):
        if line.startswith("Style: Default,"):
            parts = line.strip().split(",")
            if len(parts) >= 23:
                parts[1] = SUBTITLE_FONT
                parts[2] = str(int(SUBTITLE_FONTSIZE))
                parts[3] = SUBTITLE_PRIMARY_COLOUR
                parts[5] = SUBTITLE_OUTLINE_COLOUR
                parts[16] = str(int(SUBTITLE_OUTLINE))
                parts[17] = str(int(SUBTITLE_SHADOW))
                parts[18] = str(int(SUBTITLE_ALIGNMENT))
                parts[21] = str(int(SUBTITLE_MARGIN_V))
                lines[idx] = ",".join(parts) + "\n"
                updated = True
            break

    if updated:
        with open(ass_path, "w", encoding="utf8") as f:
            f.writelines(lines)
    else:
        log("Warning: could not update ASS style (Style: Default not found).")


# ==============================
# STEP 1
# Source zh subtitle -> <work_name>.zh.srt
# ==============================


def _probe_subtitle_streams(video_path):
    if not FFPROBE_BIN:
        raise RuntimeError(
            "ffprobe not found. Add ffprobe to PATH or install ffmpeg package including ffprobe."
        )
    result = run_command(
        [
            str(FFPROBE_BIN),
            "-v",
            "error",
            "-select_streams",
            "s",
            "-show_entries",
            "stream=index:stream_tags=language,title",
            "-of",
            "json",
            str(video_path),
        ],
        "Probe subtitle streams",
    )
    payload = json.loads(result.stdout or "{}")
    return payload.get("streams", []) or []


def _step1_extract_embedded_subtitle(video_path):
    log("Step1: embedded subtitles…")
    streams = _probe_subtitle_streams(video_path)
    if not streams:
        raise RuntimeError("No subtitle stream found in input video.")

    preferred_langs = {"zh", "zho", "chi", "cmn"}
    chosen = None
    for stream in streams:
        tags = stream.get("tags") or {}
        lang = str(tags.get("language", "")).strip().lower()
        if lang in preferred_langs:
            chosen = stream
            break
    if chosen is None:
        chosen = streams[0]

    stream_index = int(chosen.get("index", 0))
    srt_path = get_zh_srt_path()
    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-map",
            f"0:{stream_index}",
            "-c:s",
            "srt",
            str(srt_path),
        ],
        "Extract subtitle stream to SRT",
    )

    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())
    if not blocks:
        raise RuntimeError("Extracted subtitle is empty after ffmpeg conversion.")
    log(f"Step1: extracted {len(blocks)} lines.")
    return srt_path


def _step1_transcribe_with_whisper(video_path):
    log("Step1: transcribe (Whisper)…")
    from faster_whisper import WhisperModel

    # Decode to stable WAV first to avoid truncated decode from some video sources.
    step1_audio = LOG_DIR / "step1_input.wav"
    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            str(step1_audio),
        ],
        "Extract audio for Step1",
    )

    source_duration_ms = get_media_duration_ms(step1_audio) or get_media_duration_ms(
        video_path
    )
    min_expected_ms = int(source_duration_ms * 0.40) if source_duration_ms else None

    def _transcribe_with_device(device_name, out_path):
        whisper_model = WhisperModel(WHISPER_MODEL, device=device_name)
        transcribe_kwargs = {
            "language": WHISPER_LANGUAGE,
            "vad_filter": STEP1_VAD_FILTER,
            "no_speech_threshold": float(STEP1_NO_SPEECH_THRESHOLD),
            "log_prob_threshold": float(STEP1_LOGPROB_THRESHOLD),
            "condition_on_previous_text": bool(STEP1_CONDITION_ON_PREVIOUS_TEXT),
            "temperature": 0.0,
            "word_timestamps": True,
        }
        if STEP1_VAD_FILTER:
            transcribe_kwargs["vad_parameters"] = {
                "threshold": float(STEP1_VAD_THRESHOLD),
                "min_silence_duration_ms": int(STEP1_MIN_SILENCE_MS),
                "min_speech_duration_ms": int(STEP1_MIN_SPEECH_MS),
                "speech_pad_ms": int(STEP1_SPEECH_PAD_MS),
            }
        segments, _info = whisper_model.transcribe(
            str(step1_audio), **transcribe_kwargs
        )
        count = 0
        last_end_ms = 0
        prev_end_sec = 0.0
        with open(out_path, "w", encoding="utf8") as f:
            for i, segment in enumerate(
                progressbar(segments, desc=f"Transcribe ({device_name})")
            ):
                seg_start = float(segment.start)
                seg_end = float(segment.end)
                words = getattr(segment, "words", None) or []
                timed_words = [
                    (
                        float(w.start),
                        float(w.end),
                        str(getattr(w, "word", "") or "").strip(),
                    )
                    for w in words
                    if getattr(w, "start", None) is not None
                    and getattr(w, "end", None) is not None
                ]
                if timed_words:
                    seg_start = min(start for start, _end, _text in timed_words)
                    seg_end = max(end for _start, end, _text in timed_words)

                # Prevent local drift from producing overlaps/inversions in the middle of the video.
                if seg_start < prev_end_sec:
                    seg_start = prev_end_sec
                if seg_end <= seg_start:
                    seg_end = seg_start + 0.2

                split_chunks = split_segment_to_timed_chunks(
                    segment.text.strip(), seg_start, seg_end, timed_words
                )
                if not split_chunks:
                    continue

                for chunk_start_ms, chunk_end_ms, chunk_text in split_chunks:
                    chunk_start_ms, chunk_end_ms, _ = tighten_sparse_subtitle_timing(
                        chunk_start_ms,
                        chunk_end_ms,
                        chunk_text,
                    )
                    chunk_start_sec = max(prev_end_sec, chunk_start_ms / 1000.0)
                    chunk_end_sec = max(chunk_end_ms / 1000.0, chunk_start_sec + 0.2)
                    prev_end_sec = chunk_end_sec
                    last_end_ms = int(chunk_end_sec * 1000)
                    count += 1
                    f.write(f"{count}\n")
                    f.write(
                        f"{fmt_time(chunk_start_sec)} --> {fmt_time(chunk_end_sec)}\n"
                    )
                    f.write(f"{chunk_text}\n\n")

        return count, last_end_ms

    srt_path = get_zh_srt_path()

    try:
        count, last_end_ms = _transcribe_with_device("cuda", srt_path)
        if count == 0:
            raise RuntimeError("CUDA produced no segments.")
        if min_expected_ms and last_end_ms < min_expected_ms:
            count, last_end_ms = _transcribe_with_device("cpu", srt_path)
    except Exception as e:
        log(f"Step1: CUDA failed → CPU: {e}")
        count, last_end_ms = _transcribe_with_device("cpu", srt_path)
        if count == 0:
            raise RuntimeError("Whisper produced no segments in Step1.")
    log(f"Step1: done — {count} segments, {last_end_ms / 1000:.1f}s")
    return srt_path








def _step1_ocr_with_easyocr(video_path):
    """Wrapper: configure và gọi step1_easyocr.run() với config hiện tại."""
    configure_step1_easyocr(
        log=log,
        run_command=run_command,
        ffmpeg_bin=FFMPEG_BIN,
        progressbar=progressbar,
        get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time,
        get_zh_srt_path=get_zh_srt_path,
        log_dir=LOG_DIR,
        lang=EASYOCR_LANG,
        gpu=EASYOCR_GPU,
        workers=EASYOCR_WORKERS,
        subtitle_crop_band_hi=EASYOCR_SUBTITLE_CROP_BAND_HI,
        crop_probe_frames=EASYOCR_CROP_PROBE_FRAMES,
        crop_probe_h_trim_left_frac=EASYOCR_CROP_PROBE_H_TRIM_LEFT_FRAC,
        crop_probe_h_trim_right_frac=EASYOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC,
        max_strip_height_ratio=EASYOCR_MAX_STRIP_HEIGHT_RATIO,
        fps=EASYOCR_FPS,
        min_duration_ms=EASYOCR_MIN_DURATION_MS,
        min_confidence=EASYOCR_MIN_CONFIDENCE,
        low_conf_floor=EASYOCR_LOW_CONF_FLOOR,
        bridge_frames=EASYOCR_BRIDGE_FRAMES,
        bridge_min_match=EASYOCR_BRIDGE_MIN_MATCH,
        fuzzy_threshold=EASYOCR_FUZZY_THRESHOLD,
        merge_gap_ms=EASYOCR_MERGE_GAP_MS,
        gray_contrast=EASYOCR_GRAY_CONTRAST,
        gray_brightness=EASYOCR_GRAY_BRIGHTNESS,
        gray_gamma=EASYOCR_GRAY_GAMMA,
        luma_suppress=EASYOCR_LUMA_SUPPRESS,
        white_thresh=EASYOCR_WHITE_THRESH,
        histeq_strength=EASYOCR_HISTEQ_STRENGTH,
        gray_invert=EASYOCR_GRAY_INVERT,
        unsharp=EASYOCR_UNSHARP,
        text_skip_defaults_on=EASYOCR_TEXT_SKIP_DEFAULTS_ON,
        text_skip_regexes_json=EASYOCR_TEXT_SKIP_REGEXES_JSON,
    )
    return _step1_easyocr_run(video_path)


def _step1_ocr_with_paddleocr(video_path):
    """Wrapper: configure và gọi step1_paddleocr.run() với config hiện tại."""
    configure_step1_paddleocr(
        log=log,
        run_command=run_command,
        ffmpeg_bin=FFMPEG_BIN,
        get_media_duration_ms=get_media_duration_ms,
        fmt_time=fmt_time,
        get_zh_srt_path=get_zh_srt_path,
        log_dir=LOG_DIR,
        lang=PADDLEOCR_LANG,
        use_gpu=PADDLEOCR_USE_GPU,
        use_angle_cls=PADDLEOCR_USE_ANGLE_CLS,
        subtitle_crop_band_hi=PADDLEOCR_SUBTITLE_CROP_BAND_HI,
        crop_probe_frames=PADDLEOCR_CROP_PROBE_FRAMES,
        crop_probe_h_trim_left_frac=PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC,
        crop_probe_h_trim_right_frac=PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC,
        max_strip_height_ratio=PADDLEOCR_MAX_STRIP_HEIGHT_RATIO,
        scan_fps=PADDLEOCR_SCAN_FPS,
        framediff_threshold=PADDLEOCR_FRAMEDIFF_THRESHOLD,
        framediff_skip_blank=PADDLEOCR_FRAMEDIFF_SKIP_BLANK,
        batch_size=PADDLEOCR_BATCH_SIZE,
        min_confidence=PADDLEOCR_MIN_CONFIDENCE,
        low_conf_floor=PADDLEOCR_LOW_CONF_FLOOR,
        bridge_frames=PADDLEOCR_BRIDGE_FRAMES,
        bridge_min_match=PADDLEOCR_BRIDGE_MIN_MATCH,
        fuzzy_threshold=PADDLEOCR_FUZZY_THRESHOLD,
        merge_gap_ms=PADDLEOCR_MERGE_GAP_MS,
        min_duration_ms=PADDLEOCR_MIN_DURATION_MS,
        gray_contrast=PADDLEOCR_GRAY_CONTRAST,
        gray_brightness=PADDLEOCR_GRAY_BRIGHTNESS,
        gray_gamma=PADDLEOCR_GRAY_GAMMA,
        luma_suppress=PADDLEOCR_LUMA_SUPPRESS,
        white_thresh=PADDLEOCR_WHITE_THRESH,
        histeq_strength=PADDLEOCR_HISTEQ_STRENGTH,
        gray_invert=PADDLEOCR_GRAY_INVERT,
        unsharp=PADDLEOCR_UNSHARP,
        watermark_blacklist=PADDLEOCR_WATERMARK_BLACKLIST,
        watermark_min_frames=PADDLEOCR_WATERMARK_MIN_FRAMES,
    )
    return _step1_paddleocr_run(video_path)


def step1_transcribe(video_path):
    source_mode = str(STEP1_SUBTITLE_SOURCE or "whisper").strip().lower()
    if source_mode == "embedded":
        return _step1_extract_embedded_subtitle(video_path)
    if source_mode == "whisper":
        return _step1_transcribe_with_whisper(video_path)
    if source_mode == "easyocr":
        return _step1_ocr_with_easyocr(video_path)
    if source_mode == "paddleocr":
        return _step1_ocr_with_paddleocr(video_path)
    raise RuntimeError(
        f"Unsupported Step1 source: {STEP1_SUBTITLE_SOURCE}. "
        "Use --step1-subtitle-source whisper|embedded|easyocr|paddleocr."
    )


# ==============================
# STEP 3
# TTS generate voice directly from SRT (chunked)
# Edge TTS: step3_edge.py
# ==============================


def _omnivoice_resolve_device_map(raw: str) -> str:
    r = str(raw or "").strip()
    if r:
        return r
    import torch

    return "cuda:0" if torch.cuda.is_available() else "cpu"


def step3_generate_voice_from_srt(srt_path, target_duration_ms=None):
    eng = str(STEP3_TTS_ENGINE or "edge").strip().lower()
    if eng not in ("edge", "omnivoice"):
        raise ValueError(f"Step3: --step3-tts-engine không hợp lệ: {eng!r}")
    use_omnivoice = eng == "omnivoice"
    omni_ref_prepared = None
    omni_device = None

    configure_step3_edge(
        log=log,
        run_command=run_command,
        ffmpeg_bin=FFMPEG_BIN,
        edge_tts_voice=EDGE_TTS_VOICE,
        edge_tts_volume=EDGE_TTS_VOLUME,
        edge_tts_pitch=EDGE_TTS_PITCH,
        step3_tts_api_timeout_sec=STEP3_TTS_API_TIMEOUT_SEC,
    )

    if use_omnivoice:
        log("Step3: OmniVoice Vietnamese (timeline SRT)…")
        _omni_mid = str(OMNIVOICE_MODEL_ID or "").strip()
        if not _omni_mid:
            raise ValueError("OmniVoice: cần OMNIVOICE_MODEL_ID trong auto_vietsub_pro.py (HF repo id).")
        spk = Path(str(OMNIVOICE_REF_WAV or "").strip()).expanduser()
        if not str(OMNIVOICE_REF_WAV or "").strip() or not spk.is_file():
            raise FileNotFoundError(
                f"OmniVoice: cần OMNIVOICE_REF_WAV (giọng mẫu): {spk}"
            )
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        omni_ref_prepared = prepare_speaker_reference(spk, LOG_DIR)
        omni_device = _omnivoice_resolve_device_map(str(OMNIVOICE_DEVICE_MAP or ""))
        if not str(OMNIVOICE_REF_TEXT or "").strip():
            raise ValueError(
                "OmniVoice: cần OMNIVOICE_REF_TEXT (transcript của giọng mẫu) trong auto_vietsub_pro.py. "
                "Để trống sẽ kích hoạt auto ASR và có thể kéo TorchCodec/FFmpeg runtime."
            )
        log(
            "OmniVoice: đã chuẩn bị giọng mẫu "
            f"{spk.name} → {Path(omni_ref_prepared).name} (device={omni_device})"
        )
    else:
        log("Step3: edge-tts (timeline SRT)…")

    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())
    if not blocks:
        raise ValueError("Vietnamese subtitle file has no valid subtitle blocks.")

    has_text = any(b["text"].strip() for b in blocks)
    if not has_text:
        raise ValueError("Vietnamese subtitle file has no text content for TTS.")

    chunk_dir = LOG_DIR / "tts_chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    done_block_indices = (
        _step3_load_voice_checkpoint(srt_path, chunk_dir, len(blocks))
        if STEP3_VOICE_RESUME
        else set()
    )
    if STEP3_VOICE_RESUME:
        _step3_prune_voice_checkpoint_missing_wavs(
            done_block_indices, srt_path, chunk_dir, blocks
        )
    if STEP3_VOICE_RESUME and done_block_indices:
        log(f"Step3: resume {len(done_block_indices)} segments (checkpoint).")
    timeline_paths = []
    current_time_ms = 0

    for i, block in enumerate(progressbar(blocks, desc="TTS timeline")):
        start_ms, end_ms = parse_srt_time_range(block["time"])
        if end_ms <= start_ms:
            continue

        # Insert silence before subtitle if there is a gap.
        if start_ms > current_time_ms:
            gap_ms = start_ms - current_time_ms
            silence_path = chunk_dir / f"gap_{i:04d}.wav"
            run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=24000:cl=mono",
                    "-t",
                    f"{gap_ms / 1000:.3f}",
                    "-c:a",
                    "pcm_s16le",
                    str(silence_path),
                ],
                f"Create silence gap {i}",
            )
            timeline_paths.append(silence_path.resolve())
            current_time_ms = start_ms

        subtitle_duration_ms = end_ms - start_ms
        subtitle_text = sanitize_tts_text(block["text"])

        # Empty text block keeps timing with silence segment.
        if not subtitle_text:
            empty_path = chunk_dir / f"empty_{i:04d}.wav"
            if (
                STEP3_VOICE_RESUME
                and i in done_block_indices
                and file_ready(empty_path)
            ):
                timeline_paths.append(empty_path.resolve())
                current_time_ms = end_ms
                continue
            run_command(
                [
                    FFMPEG_BIN,
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "anullsrc=r=24000:cl=mono",
                    "-t",
                    f"{subtitle_duration_ms / 1000:.3f}",
                    "-c:a",
                    "pcm_s16le",
                    str(empty_path),
                ],
                f"Create empty subtitle silence {i}",
            )
            timeline_paths.append(empty_path.resolve())
            current_time_ms = end_ms
            done_block_indices.add(i)
            _step3_save_voice_checkpoint(
                srt_path, chunk_dir, blocks, done_block_indices
            )
            continue

        raw_ext = "wav" if use_omnivoice else "mp3"
        raw_audio_path = chunk_dir / f"raw_{i:04d}.{raw_ext}"
        final_seg_path = chunk_dir / f"part_{i:04d}.wav"

        if (
            STEP3_VOICE_RESUME
            and i in done_block_indices
            and file_ready(final_seg_path)
        ):
            seg_ms = get_media_duration_ms(final_seg_path)
            if not seg_ms:
                seg_ms = int(subtitle_duration_ms)
            timeline_paths.append(final_seg_path.resolve())
            current_time_ms = start_ms + int(seg_ms)
            continue

        def run_tts(rate):
            sleep_ms = max(0, int(STEP3_TTS_REQUEST_SLEEP_MS))
            if sleep_ms > 0:
                time.sleep(sleep_ms / 1000.0)
            if use_omnivoice:
                from omnivoice_tts import synthesize_to_wav

                tts_omni = tts_normalize_vi(subtitle_text, OMNIVOICE_NORMALIZE_TEXT)
                ns = int(OMNIVOICE_NUM_STEP)
                gs = float(OMNIVOICE_GUIDANCE_SCALE)
                synthesize_to_wav(
                    text=tts_omni,
                    out_wav=raw_audio_path,
                    ref_audio=omni_ref_prepared,
                    ref_text=str(OMNIVOICE_REF_TEXT or ""),
                    model_id=str(OMNIVOICE_MODEL_ID or "").strip(),
                    device_map=omni_device,
                    dtype_str=str(OMNIVOICE_DTYPE or "float16").strip() or "float16",
                    language=str(OMNIVOICE_LANGUAGE or "vietnamese").strip()
                    or "vietnamese",
                    num_step=ns if ns > 0 else None,
                    guidance_scale=gs if ns > 0 else None,
                    seed=OMNIVOICE_SEED if OMNIVOICE_SEED is not None else None,
                )
            else:
                run_edge_tts_mp3_save(subtitle_text, raw_audio_path, rate)

        tts_rate, _ = resolve_dynamic_tts_rate(subtitle_text, subtitle_duration_ms)
        subtitle_idx = block.get("index", i + 1)
        tts_retry_label = f"Step3 TTS seg {subtitle_idx} (timeline {i})"
        ok_tts = step3_tts_retry(
            lambda: run_tts(tts_rate),
            tts_retry_label,
            max_retry=TTS_RETRY_MAX,
        )
        if not ok_tts:
            # Im lặng đúng khung SRT [start_ms, end_ms], khớp current_time_ms như nhánh câu rỗng.
            _write_step3_silent_wav(
                final_seg_path,
                subtitle_duration_ms,
                f"Step3 TTS skip: silent track slot {start_ms}-{end_ms}ms ({subtitle_duration_ms}ms) idx={i}",
            )
            timeline_paths.append(final_seg_path.resolve())
            current_time_ms = end_ms
            done_block_indices.add(i)
            _step3_save_voice_checkpoint(
                srt_path, chunk_dir, blocks, done_block_indices
            )
            continue

        raw_segment_ms = get_media_duration_ms(raw_audio_path)
        if (
            (not use_omnivoice)
            and STEP3_AUTO_RATE_ENABLED
            and raw_segment_ms
            and subtitle_duration_ms > 220
        ):
            stretch_pre = raw_segment_ms / float(subtitle_duration_ms)
            if stretch_pre > 1.12:
                pushed_ms = int(subtitle_duration_ms / min(stretch_pre, 1.85))
                pushed_ms = max(220, min(pushed_ms, subtitle_duration_ms - 1))
                tts_rate_2, _ = resolve_dynamic_tts_rate(subtitle_text, pushed_ms)
                b1 = parse_percent_string(tts_rate, 0.0)
                b2 = parse_percent_string(tts_rate_2, 0.0)
                if b2 > b1 + 0.5:
                    tts_rate = tts_rate_2
                    tts_retry_label_2 = f"Step3 TTS seg {subtitle_idx} pass2 (timeline {i})"
                    pass2_backup = chunk_dir / f"raw_{i:04d}_before_pass2_audio.bak"
                    # copy2() may fail with EPERM on some Linux/WSL mounts when copying metadata.
                    shutil.copyfile(raw_audio_path, pass2_backup)
                    try:
                        ok_tts2 = step3_tts_retry(
                            lambda: run_tts(tts_rate),
                            tts_retry_label_2,
                            max_retry=TTS_RETRY_MAX,
                        )
                        if not ok_tts2:
                            shutil.copyfile(pass2_backup, raw_audio_path)
                    finally:
                        try:
                            pass2_backup.unlink()
                        except OSError:
                            pass
                    raw_segment_ms = get_media_duration_ms(raw_audio_path)

        # Latest instant we may end this speech without overlapping the next cue (when borrow-gap on).
        if i + 1 < len(blocks):
            next_start_ms, _ = parse_srt_time_range(blocks[i + 1]["time"])
        else:
            next_start_ms = end_ms + 86_400_000
        if STEP3_TTS_BORROW_GAP:
            max_fit_ms = max(subtitle_duration_ms, next_start_ms - start_ms)
        else:
            max_fit_ms = subtitle_duration_ms
        if max_fit_ms < subtitle_duration_ms:
            max_fit_ms = subtitle_duration_ms

        if not raw_segment_ms or raw_segment_ms <= 0:
            raw_segment_ms = subtitle_duration_ms

        fit_filters = []
        if use_omnivoice and OMNIVOICE_TRIM_TRAILING_SILENCE:
            stop_dur = max(
                0.02, float(OMNIVOICE_TRAILING_SILENCE_MIN_MS) / 1000.0
            )
            stop_thr = float(OMNIVOICE_TRAILING_SILENCE_THRESHOLD_DB)
            fit_filters.append(
                f"silenceremove=stop_periods=-1:stop_duration={stop_dur:.3f}:stop_threshold={stop_thr:.1f}dB"
            )
        if raw_segment_ms > max_fit_ms:
            stretch_factor = raw_segment_ms / float(max_fit_ms)
            if stretch_factor > 1.02:
                fit_filters.append(build_atempo_filter(stretch_factor))
            target_duration_ms = int(max_fit_ms)
        elif raw_segment_ms > subtitle_duration_ms:
            # Borrow gap: keep full TTS length when it fits before next subtitle start.
            target_duration_ms = int(raw_segment_ms)
        else:
            target_duration_ms = int(subtitle_duration_ms)

        td_sec = target_duration_ms / 1000.0
        fit_filters.append(f"apad=pad_dur={td_sec:.3f}")
        fit_filters.append(f"atrim=duration={td_sec:.3f}")
        fade_d = min(0.12, max(0.02, td_sec * 0.2))
        fade_start = max(0.0, td_sec - fade_d)
        fit_filters.append(f"afade=t=out:st={fade_start:.3f}:d={fade_d:.3f}")

        run_command(
            [
                FFMPEG_BIN,
                "-y",
                "-i",
                str(raw_audio_path),
                "-af",
                ",".join(fit_filters),
                "-ac",
                "1",
                "-ar",
                "24000",
                "-c:a",
                "pcm_s16le",
                str(final_seg_path),
            ],
            f"Normalize subtitle segment {i}",
        )
        timeline_paths.append(final_seg_path.resolve())
        current_time_ms = start_ms + target_duration_ms
        done_block_indices.add(i)
        _step3_save_voice_checkpoint(srt_path, chunk_dir, blocks, done_block_indices)

    # Ensure final audio length reaches subtitle end or requested target duration.
    _start_ms, last_end_ms = parse_srt_time_range(blocks[-1]["time"])
    required_end_ms = max(last_end_ms, int(target_duration_ms or 0))
    if required_end_ms > current_time_ms:
        tail_ms = required_end_ms - current_time_ms
        tail_path = chunk_dir / "tail_silence.wav"
        run_command(
            [
                FFMPEG_BIN,
                "-y",
                "-f",
                "lavfi",
                "-i",
                "anullsrc=r=24000:cl=mono",
                "-t",
                f"{tail_ms / 1000:.3f}",
                "-c:a",
                "pcm_s16le",
                str(tail_path),
            ],
            "Create tail silence",
        )
        timeline_paths.append(tail_path.resolve())

    audio_path = VIDEO_DIR / f"{WORK_NAME}_voice.wav"
    concat_list = chunk_dir / "concat_list.txt"
    write_ffmpeg_concat_list(timeline_paths, concat_list)

    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_list),
            "-c",
            "copy",
            str(audio_path),
        ],
        "Concatenate Step3 TTS timeline segments",
    )
    return audio_path


# ==============================
# STEP 4
# Merge voice with video
# ==============================


def step4_merge_audio(video_path, voice_path):
    log("Step4: merge audio…")
    out = VIDEO_DIR / f"{WORK_NAME}_tm.mp4"
    s = float(STEP4_MERGE_SPEED)
    if abs(s - 1.0) < 1e-6:
        run_command(
            [
                FFMPEG_BIN,
                "-y",
                "-i",
                str(video_path),
                "-i",
                str(voice_path),
                "-filter_complex",
                (
                    f"[0:a]volume={float(ORIGINAL_AUDIO_VOLUME):.6f}[orig];"
                    f"[1:a]volume={float(NARRATION_AUDIO_VOLUME):.6f}[voice];"
                    "[orig][voice]amix=inputs=2:duration=first:dropout_transition=0[aout]"
                ),
                "-map",
                "0:v",
                "-map",
                "[aout]",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-shortest",
                *ffmpeg_output_metadata_args(out),
                str(out),
            ],
            "Merge narration audio",
        )
        return out

    if s <= 0:
        raise ValueError(f"step4-merge-speed must be > 0, got {s}")

    at = build_atempo_filter(s)
    orig_a = f"{at},volume={float(ORIGINAL_AUDIO_VOLUME):.6f}"
    voice_a = f"{at},volume={float(NARRATION_AUDIO_VOLUME):.6f}"
    fc = (
        f"[0:v]setpts=PTS/{s:.6f}[v];"
        f"[0:a]{orig_a}[orig];"
        f"[1:a]{voice_a}[voice];"
        "[orig][voice]amix=inputs=2:duration=first:dropout_transition=0[aout]"
    )
    meta = ffmpeg_output_metadata_args(out)
    gpu_cmd = [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-i",
        str(voice_path),
        "-filter_complex",
        fc,
        "-map",
        "[v]",
        "-map",
        "[aout]",
        *ffmpeg_video_encode_args(True),
        "-c:a",
        "aac",
        "-shortest",
        *meta,
        str(out),
    ]
    try:
        run_command(gpu_cmd, "Merge narration audio (pre-merge speed, GPU)")
    except Exception as e:
        log(f"Step4: GPU encode failed → CPU: {e}")
        cpu_cmd = [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(voice_path),
            "-filter_complex",
            fc,
            "-map",
            "[v]",
            "-map",
            "[aout]",
            *ffmpeg_video_encode_args(False),
            "-c:a",
            "aac",
            "-shortest",
            *meta,
            str(out),
        ]
        run_command(cpu_cmd, "Merge narration audio (pre-merge speed, CPU)")
    return out


def _resolve_export_target_wh(source_wh):
    """Map --export-resolution → (W,H); source/auto giữ WxH Step6."""
    key = str(EXPORT_RESOLUTION or "source").strip().lower()
    if key in ("", "source", "auto"):
        return source_wh
    preset = EXPORT_RESOLUTION_PRESETS.get(key)
    if not preset:
        log(f"Step7: unknown export-resolution '{key}', keeping source size.")
        return source_wh
    return preset


def _video_wh_needs_resize(source_wh, target_wh):
    if not source_wh or not target_wh:
        return False
    return int(source_wh[0]) != int(target_wh[0]) or int(source_wh[1]) != int(target_wh[1])


def build_step7_finalize_command(
    video_path, part_path, speed, use_gpu, has_audio, source_wh, target_wh
):
    """Step7: setpts/atempo (speed) + scale/pad (export resolution)."""
    meta = ffmpeg_output_metadata_args(part_path)
    v_enc = ffmpeg_video_encode_args(use_gpu)

    speed = float(speed)
    apply_speed = abs(speed - 1.0) > 1e-6
    apply_resize = _video_wh_needs_resize(source_wh, target_wh)

    v_chain = []
    if apply_speed:
        v_chain.append(f"setpts=PTS/{speed:.6f}")
    if apply_resize and target_wh:
        v_chain.append(_step7_scale_pad_filter(int(target_wh[0]), int(target_wh[1])))
    elif apply_speed and source_wh and int(source_wh[0]) > 1 and int(source_wh[1]) > 1:
        v_chain.append(
            f"scale={int(source_wh[0])}:{int(source_wh[1])}:flags=bicubic+accurate_rnd"
        )

    if not v_chain:
        return None

    vt = f"[0:v]{','.join(v_chain)}[v]"

    if apply_speed and has_audio:
        atempo_filter = build_atempo_filter(speed)
        return [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-filter_complex",
            f"{vt};[0:a]{atempo_filter}[a]",
            "-map",
            "[v]",
            "-map",
            "[a]",
            *v_enc,
            "-c:a",
            "aac",
            *meta,
            "-f",
            "mp4",
            str(part_path),
        ]
    if has_audio and not apply_speed:
        return [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-filter_complex",
            vt,
            "-map",
            "[v]",
            "-map",
            "0:a",
            *v_enc,
            "-c:a",
            "aac",
            *meta,
            "-f",
            "mp4",
            str(part_path),
        ]
    return [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-filter_complex",
        vt,
        "-map",
        "[v]",
        *v_enc,
        "-an",
        *meta,
        "-f",
        "mp4",
        str(part_path),
    ]


def _run_step7_encode(video_path, part_path, speed, source_wh, target_wh, step_label):
    speed = float(speed)
    if speed <= 0:
        raise ValueError(f"{step_label}: speed must be > 0, got {speed}")

    has_audio = media_has_audio_stream(video_path)
    gpu_cmd = build_step7_finalize_command(
        video_path,
        part_path,
        speed,
        use_gpu=True,
        has_audio=has_audio,
        source_wh=source_wh,
        target_wh=target_wh,
    )
    if gpu_cmd is None:
        return False
    try:
        run_command(gpu_cmd, f"{step_label} (GPU)")
    except Exception as e:
        log(f"{step_label}: GPU encode failed → CPU: {e}")
        cpu_cmd = build_step7_finalize_command(
            video_path,
            part_path,
            speed,
            use_gpu=False,
            has_audio=has_audio,
            source_wh=source_wh,
            target_wh=target_wh,
        )
        if cpu_cmd is None:
            return False
        run_command(cpu_cmd, f"{step_label} (CPU)")
    return True


def _apply_speed_to_output(video_path, speed, out_path, part_path, step_label):
    """setpts + atempo → out_path (Step0 preprocess; không đổi resolution)."""
    speed = float(speed)
    if speed <= 0:
        raise ValueError(f"{step_label}: speed must be > 0, got {speed}")

    source_wh = get_ffprobe_video_dimensions(video_path)
    if not _run_step7_encode(
        video_path, part_path, speed, source_wh, source_wh, step_label
    ):
        raise RuntimeError(f"{step_label}: encode command missing.")
    try:
        os.replace(part_path, out_path)
    except OSError:
        if part_path.is_file():
            part_path.unlink(missing_ok=True)
        raise
    return out_path


def step0_preprocess_speed(video_path):
    """Trước Step1: encode video với setpts/atempo khi --preprocess-speed != 1."""
    speed = float(PREPROCESS_SPEED)
    if abs(speed - 1.0) < 1e-6:
        return video_path

    out = VIDEO_DIR / f"{WORK_NAME}_pre.mp4"
    part = VIDEO_DIR / f"{WORK_NAME}_pre.mp4.part"
    _apply_speed_to_output(
        video_path, speed, out, part, "Step0 preprocess-speed"
    )
    if not file_ready(out):
        raise RuntimeError("Step0 preprocess-speed output is missing or empty.")
    log(f"Step0: preprocessed video → {out}")
    return out


def step7_finalize(video_path):
    """Step7: speed-video + export-resolution (scale/pad) trên *_vs_tm.mp4."""
    speed = float(SPEED_VIDEO)
    if speed <= 0:
        raise ValueError(f"speed-video must be > 0, got {speed}")

    source_wh = get_ffprobe_video_dimensions(video_path)
    target_wh = _resolve_export_target_wh(source_wh)
    apply_speed = abs(speed - 1.0) > 1e-6
    apply_resize = _video_wh_needs_resize(source_wh, target_wh)

    if not apply_speed and not apply_resize:
        return video_path

    final_out = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    part = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4.part"
    label = "Step7 finalize"
    if apply_resize and target_wh:
        label += f" → {int(target_wh[0])}x{int(target_wh[1])}"
    if apply_speed:
        label += f" x{speed:.3f}"

    if not _run_step7_encode(
        video_path, part, speed, source_wh, target_wh, label
    ):
        return video_path

    try:
        os.replace(part, final_out)
    except OSError:
        if part.is_file():
            part.unlink(missing_ok=True)
        raise
    if not file_ready(final_out):
        raise RuntimeError("Step7 finalize output is missing or empty.")
    return final_out


def _step7_scale_pad_filter(w, h):
    return (
        f"scale={int(w)}:{int(h)}:force_original_aspect_ratio=decrease,"
        f"pad={int(w)}:{int(h)}:(ow-iw)/2:(oh-ih)/2,setsar=1"
    )


def build_step7_merge_outro_command(main_path, outro_path, part_path, use_gpu):
    """Ghép main (_vs_tm) + outro; scale outro khớp WxH main."""
    wh = get_ffprobe_video_dimensions(main_path)
    if not wh or int(wh[0]) < 2 or int(wh[1]) < 2:
        raise RuntimeError("Cannot read main video dimensions for outro merge.")
    w, h = int(wh[0]), int(wh[1])
    scale = _step7_scale_pad_filter(w, h)
    main_has_audio = media_has_audio_stream(main_path)
    outro_has_audio = media_has_audio_stream(outro_path)
    meta = ffmpeg_output_metadata_args(part_path)
    v_enc = ffmpeg_video_encode_args(use_gpu)

    a_fmt = "aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo"
    if main_has_audio and outro_has_audio:
        fc = (
            f"[0:v]{scale}[v0];[1:v]{scale}[v1];"
            f"[0:a]{a_fmt}[a0];[1:a]{a_fmt}[a1];"
            f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
        )
        maps = ["-map", "[outv]", "-map", "[outa]", "-c:a", "aac"]
    elif main_has_audio:
        outro_dur = get_media_duration_ms(outro_path)
        dur_s = max(0.1, (outro_dur or 1000) / 1000.0)
        fc = (
            f"[0:v]{scale}[v0];[1:v]{scale}[v1];"
            f"[0:a]{a_fmt}[a0];"
            f"anullsrc=r=44100:cl=stereo:d={dur_s:.3f}[a1];"
            f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
        )
        maps = ["-map", "[outv]", "-map", "[outa]", "-c:a", "aac"]
    elif outro_has_audio:
        main_dur = get_media_duration_ms(main_path)
        dur_s = max(0.1, (main_dur or 1000) / 1000.0)
        fc = (
            f"[0:v]{scale}[v0];[1:v]{scale}[v1];"
            f"anullsrc=r=44100:cl=stereo:d={dur_s:.3f}[a0];"
            f"[1:a]{a_fmt}[a1];"
            f"[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]"
        )
        maps = ["-map", "[outv]", "-map", "[outa]", "-c:a", "aac"]
    else:
        fc = f"[0:v]{scale}[v0];[1:v]{scale}[v1];[v0][v1]concat=n=2:v=1:a=0[outv]"
        maps = ["-map", "[outv]", "-an"]

    return [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(main_path),
        "-i",
        str(outro_path),
        "-filter_complex",
        fc,
        *maps,
        *v_enc,
        *meta,
        "-f",
        "mp4",
        str(part_path),
    ]


def step7_merge_outro(main_video_path):
    """Giữ main tại *_vs_tm.mp4; tạo thêm *_vs_tm_outro.mp4."""
    configured = Path(OUTRO_FILE or "")
    outro_path = (
        configured if configured.is_absolute() else (SCRIPT_DIR / configured)
    ).resolve()
    if not file_ready(outro_path):
        raise FileNotFoundError(f"Outro file not ready: {outro_path}")

    base_out = Path(main_video_path).resolve()
    with_outro = VIDEO_DIR / f"{WORK_NAME}_vs_tm_outro.mp4"
    part = VIDEO_DIR / f"{WORK_NAME}_vs_tm_outro.mp4.part"

    gpu_cmd = build_step7_merge_outro_command(
        base_out, outro_path, part, use_gpu=True
    )
    try:
        run_command(gpu_cmd, "Step7: merge outro (GPU)")
    except Exception as e:
        log(f"Step7: merge outro GPU failed → CPU: {e}")
        cpu_cmd = build_step7_merge_outro_command(
            base_out, outro_path, part, use_gpu=False
        )
        run_command(cpu_cmd, "Step7: merge outro (CPU)")

    try:
        os.replace(part, with_outro)
    except OSError:
        if part.is_file():
            part.unlink(missing_ok=True)
        raise

    if not file_ready(with_outro):
        raise RuntimeError("Step7 outro merge output is missing or empty.")

    log(f"Step7: base video (subs+TTS): {base_out}")
    log(f"Step7: with outro: {with_outro}")
    return with_outro


# ==============================
# STEP 5
# convert srt -> ass
# ==============================


def step5_convert_ass(srt_path):
    log("Step5: SRT → ASS…")
    ass = SUBTITLE_DIR / "sub.ass"
    srt_for_ass = Path(srt_path)
    temp_upper_srt = None
    if SUBTITLE_UPPERCASE:
        with open(srt_path, encoding="utf8") as f:
            blocks = parse_srt(f.read())
        temp_upper_srt = SUBTITLE_DIR / "__step5_uppercase_tmp.srt"
        write_srt(
            [
                {
                    "index": b["index"],
                    "time": b["time"],
                    "text": str(b["text"]).upper(),
                }
                for b in blocks
            ],
            temp_upper_srt,
        )
        srt_for_ass = temp_upper_srt

    run_command(
        [FFMPEG_BIN, "-y", "-i", str(srt_for_ass), str(ass)], "Convert SRT to ASS"
    )
    if temp_upper_srt and temp_upper_srt.exists():
        temp_upper_srt.unlink()
    update_ass_default_style(ass)
    return ass


# ==============================
# STEP 6
# render subtitle
# ==============================


def step6_render(video_path, ass_path):
    log("Step6: render + subs…")
    out = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    probe_wh = None
    if STEP6_VISUAL_TRANSFORM_ENABLED and float(STEP6_ZOOM_PERCENT) > 0.01:
        probe_wh = get_ffprobe_video_dimensions(video_path)
    subtitle_filter = build_subtitle_filter(ass_path, probe_wh)
    logo_path = None
    if LOGO_ENABLED:
        configured_logo = Path(LOGO_FILE)
        # Resolve relative logo paths from this script directory
        # so changing LOGO_FILE in code always takes effect.
        logo_path = (
            configured_logo
            if configured_logo.is_absolute()
            else (SCRIPT_DIR / configured_logo)
        ).resolve()
        if not file_ready(logo_path):
            logo_path = None

    gpu_cmd = build_step6_render_command(
        video_path, out, subtitle_filter, use_gpu=True, logo_path=logo_path
    )
    try:
        run_command(gpu_cmd, "Render ASS subtitles (GPU)")
    except Exception as e:
        log(f"Step6: GPU render failed → CPU: {e}")
        cpu_cmd = build_step6_render_command(
            video_path, out, subtitle_filter, use_gpu=False, logo_path=logo_path
        )
        run_command(cpu_cmd, "Render ASS subtitles (CPU fallback)")
    return out


def get_or_run(path, step_name, step_func, *args):
    p = Path(path)
    if file_ready(p):
        log(f"{step_name}: cached output.")
        return p
    result = step_func(*args)
    if not file_ready(result):
        raise RuntimeError(f"{step_name} output is missing or empty: {result}")
    return result


def parse_cli_args():
    parser = argparse.ArgumentParser(
        description="Auto translate + TTS narration + subtitle render pipeline."
    )
    parser.add_argument("video", help="Input video file path.")

    # Subtitle style options
    parser.add_argument("--subtitle-font", default=SUBTITLE_FONT)
    parser.add_argument("--subtitle-fontsize", type=int, default=SUBTITLE_FONTSIZE)
    parser.add_argument("--subtitle-primary-colour", default=SUBTITLE_PRIMARY_COLOUR)
    parser.add_argument("--subtitle-outline-colour", default=SUBTITLE_OUTLINE_COLOUR)
    parser.add_argument("--subtitle-outline", type=int, default=SUBTITLE_OUTLINE)
    parser.add_argument("--subtitle-shadow", type=int, default=SUBTITLE_SHADOW)
    parser.add_argument("--subtitle-alignment", type=int, default=SUBTITLE_ALIGNMENT)
    parser.add_argument("--subtitle-margin-v", type=int, default=SUBTITLE_MARGIN_V)
    parser.add_argument(
        "--subtitle-uppercase",
        choices=["on", "off"],
        default="on" if SUBTITLE_UPPERCASE else "off",
        help="Force subtitle text to uppercase when writing SRT files.",
    )
    parser.add_argument(
        "--subtitle-bg-blur-width-ratio",
        type=float,
        default=SUBTITLE_BG_BLUR_WIDTH_RATIO,
    )
    parser.add_argument(
        "--subtitle-bg-blur-height", type=int, default=SUBTITLE_BG_BLUR_HEIGHT
    )
    parser.add_argument(
        "--subtitle-bg-blur-bottom-offset",
        type=int,
        default=SUBTITLE_BG_BLUR_BOTTOM_OFFSET,
    )
    parser.add_argument(
        "--subtitle-bg-blur-luma-radius", type=int, default=SUBTITLE_BG_BLUR_LUMA_RADIUS
    )
    parser.add_argument(
        "--subtitle-bg-blur-luma-power", type=int, default=SUBTITLE_BG_BLUR_LUMA_POWER
    )
    parser.add_argument(
        "--subtitle-bg-blur-chroma-radius",
        type=int,
        default=SUBTITLE_BG_BLUR_CHROMA_RADIUS,
    )
    parser.add_argument(
        "--subtitle-bg-blur-chroma-power",
        type=int,
        default=SUBTITLE_BG_BLUR_CHROMA_POWER,
    )

    # Logo options
    parser.add_argument("--logo-file", default=LOGO_FILE)
    parser.add_argument("--logo-width", type=int, default=LOGO_WIDTH)
    parser.add_argument("--logo-margin-x", type=int, default=LOGO_MARGIN_X)
    parser.add_argument("--logo-margin-y", type=int, default=LOGO_MARGIN_Y)
    parser.add_argument("--logo-opacity", type=float, default=LOGO_OPACITY)
    parser.add_argument(
        "--logo-enabled",
        choices=["on", "off"],
        default="on" if LOGO_ENABLED else "off",
        help="Step6: overlay logo image on video. off = skip logo even if --logo-file exists.",
    )
    parser.add_argument(
        "--merge-outro",
        choices=["on", "off"],
        default="on" if MERGE_OUTRO_ENABLED else "off",
        help="Step7: append --outro-file after final _vs_tm.mp4; keeps base file and writes *_vs_tm_outro.mp4.",
    )
    parser.add_argument(
        "--outro-file",
        default=OUTRO_FILE,
        help="Outro clip path (absolute or relative to script dir). Required when --merge-outro on.",
    )
    parser.add_argument(
        "--step6-visual-transform",
        choices=["on", "off"],
        default="on" if STEP6_VISUAL_TRANSFORM_ENABLED else "off",
        help="Step6: hflip, zoom (scale+crop), eq sat/contrast, unsharp before ASS.",
    )
    parser.add_argument(
        "--step6-hflip",
        choices=["on", "off"],
        default="on" if STEP6_HFLIP else "off",
        help="Horizontal flip when --step6-visual-transform on.",
    )
    parser.add_argument(
        "--step6-zoom-percent",
        type=float,
        default=STEP6_ZOOM_PERCENT,
        help="Center zoom %% (scale then crop); 0 disables zoom. Typical 5–7.",
    )
    parser.add_argument(
        "--step6-unsharp",
        default=STEP6_UNSHARP,
        help='ffmpeg unsharp= params, e.g. "5:5:0.8:3:3:0.0".',
    )
    parser.add_argument(
        "--step6-eq-saturation",
        type=float,
        default=STEP6_EQ_SATURATION,
        help="ffmpeg eq saturation (1.0 = neutral).",
    )
    parser.add_argument(
        "--step6-eq-contrast",
        type=float,
        default=STEP6_EQ_CONTRAST,
        help="ffmpeg eq contrast (1.0 = neutral).",
    )
    parser.add_argument(
        "--output-metadata",
        choices=["on", "off"],
        default="on" if OUTPUT_METADATA_ENABLED else "off",
        help="Strip source metadata (-map_metadata -1) and set title/artist/comment on MP4 outputs.",
    )
    parser.add_argument(
        "--metadata-from-filename",
        choices=["on", "off"],
        default="on" if OUTPUT_METADATA_FROM_FILENAME else "off",
        help="on: title/artist/comment = stem file đầu ra. off: dùng --metadata-title/artist/comment.",
    )
    parser.add_argument(
        "--metadata-title",
        default=OUTPUT_METADATA_TITLE,
        help="MP4 metadata title (channel).",
    )
    parser.add_argument(
        "--metadata-artist", default=OUTPUT_METADATA_ARTIST, help="MP4 metadata artist."
    )
    parser.add_argument(
        "--metadata-comment",
        default=OUTPUT_METADATA_COMMENT,
        help="MP4 metadata comment.",
    )

    # Audio and speed options
    parser.add_argument("--original-volume", type=float, default=ORIGINAL_AUDIO_VOLUME)
    parser.add_argument(
        "--narration-volume", type=float, default=NARRATION_AUDIO_VOLUME
    )
    parser.add_argument(
        "--step4-merge-speed",
        type=float,
        default=STEP4_MERGE_SPEED,
        help="Step4 merge only: 1.0 = copy video. If not 1.0, re-encodes video+audio before subtitle step.",
    )
    parser.add_argument(
        "--preprocess-speed",
        type=float,
        default=PREPROCESS_SPEED,
        help="Before Step1: re-encode input with setpts/atempo (1.0 = skip, use original file).",
    )
    parser.add_argument(
        "--speed-video",
        type=float,
        default=SPEED_VIDEO,
        help="Step7 after subtitle render: re-encode *_vs_tm.mp4 in place (temp .part). 1.0 = skip speed only.",
    )
    parser.add_argument(
        "--export-resolution",
        choices=["source", "1080p", "2k", "4k"],
        default=EXPORT_RESOLUTION,
        help="Step7 output size (16:9): 1080p=1920x1080, 2k=2560x1440, 4k=3840x2160, source=keep Step6 size.",
    )
    parser.add_argument(
        "--video-codec",
        choices=["h264", "hevc"],
        default=VIDEO_CODEC,
        help="Video encode: h264 (h264_nvenc/libx264) or hevc (hevc_nvenc/libx265). GPU tried first.",
    )
    parser.add_argument(
        "--whisper-language",
        default=WHISPER_LANGUAGE,
        help="Whisper language code. Example: zh, en, vi.",
    )
    parser.add_argument(
        "--step1-subtitle-source",
        choices=["whisper", "embedded", "easyocr", "paddleocr"],
        default=STEP1_SUBTITLE_SOURCE,
        help=(
            "Step1 subtitle source: whisper=ASR from audio, "
            "embedded=extract subtitle stream with ffmpeg, "
            "easyocr=visual OCR on subtitle region (fixed FPS), "
            "paddleocr=visual OCR with Frame Difference frame selection (PP-OCRv6)."
        ),
    )
    parser.add_argument(
        "--paddleocr-lang",
        default=None,
        help="PaddleOCR language code. Default: ch (Chinese+English). Example: en, japan.",
    )
    parser.add_argument(
        "--paddleocr-use-gpu",
        choices=["on", "off"],
        default="on" if PADDLEOCR_USE_GPU else "off",
        help="Use GPU for PaddleOCR inference (default on).",
    )
    parser.add_argument(
        "--paddleocr-crop-band-hi",
        type=float,
        default=PADDLEOCR_SUBTITLE_CROP_BAND_HI,
        help="PaddleOCR crop: outer edge from bottom as fraction of frame height (default 0.20).",
    )
    parser.add_argument(
        "--paddleocr-crop-probe-h-trim-left-frac",
        type=float,
        default=PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC,
        help="PaddleOCR horizontal crop: fraction to discard from left (0–0.49, default 0.15).",
    )
    parser.add_argument(
        "--paddleocr-crop-probe-h-trim-right-frac",
        type=float,
        default=PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC,
        help="PaddleOCR horizontal crop: fraction to discard from right (0–0.49, default 0.15).",
    )
    parser.add_argument(
        "--paddleocr-min-confidence",
        type=float,
        default=PADDLEOCR_MIN_CONFIDENCE,
        help="PaddleOCR minimum confidence to keep a text result (default 0.5).",
    )
    parser.add_argument(
        "--paddleocr-scan-fps",
        type=float,
        default=PADDLEOCR_SCAN_FPS,
        help="PaddleOCR Frame Difference: FPS to scan video for change detection (default 10).",
    )
    parser.add_argument(
        "--paddleocr-framediff-threshold",
        type=float,
        default=PADDLEOCR_FRAMEDIFF_THRESHOLD,
        help=(
            "PaddleOCR Frame Difference: MAD pixel threshold (0-255) to trigger OCR on a frame. "
            "~8=subtitle changed, ~2=compression noise. Default 8.0."
        ),
    )
    parser.add_argument(
        "--paddleocr-batch-size",
        type=int,
        default=PADDLEOCR_BATCH_SIZE,
        help="PaddleOCR frames per batch inference call (default 8).",
    )
    parser.add_argument(
        "--paddleocr-min-duration-ms",
        type=int,
        default=PADDLEOCR_MIN_DURATION_MS,
        help="PaddleOCR minimum SRT cue duration ms (default 500).",
    )
    parser.add_argument(
        "--paddleocr-fuzzy-threshold",
        type=float,
        default=PADDLEOCR_FUZZY_THRESHOLD,
        help="PaddleOCR similarity %% threshold for dedup/merge (default 55).",
    )
    parser.add_argument(
        "--paddleocr-max-strip-height-ratio",
        type=float,
        default=PADDLEOCR_MAX_STRIP_HEIGHT_RATIO,
        help="Cap PaddleOCR OCR band height vs frame height; 0 disables (default 0.05).",
    )
    parser.add_argument(
        "--paddleocr-cleanup-debug-after-step7",
        choices=["on", "off"],
        default="on" if PADDLEOCR_CLEANUP_DEBUG_AFTER_STEP7 else "off",
        help="on (default): delete LOG_DIR/step1_paddleocr after Step7. off: keep for inspection.",
    )
    parser.add_argument(
        "--paddleocr-watermark-blacklist",
        default=PADDLEOCR_WATERMARK_BLACKLIST,
        help="Comma-separated watermark platform names to filter (substring match). Default: common Chinese platforms.",
    )
    parser.add_argument(
        "--paddleocr-watermark-min-frames",
        type=int,
        default=PADDLEOCR_WATERMARK_MIN_FRAMES,
        help="Frequency filter threshold: text on more frames than this is treated as watermark. 0=auto (80%% of total scanned).",
    )
    parser.add_argument(
        "--easyocr-lang",
        default=None,
        help="Comma-separated EasyOCR language codes. Example: ch_sim,en (default).",
    )
    parser.add_argument(
        "--easyocr-crop-band-hi",
        type=float,
        default=EASYOCR_SUBTITLE_CROP_BAND_HI,
        help=(
            "EasyOCR crop: outer edge (high limit) from bottom as fraction of frame height (default 0.20). "
            "Band is pixels between band-lo and band-hi from the frame bottom."
        ),
    )
    parser.add_argument(
        "--easyocr-crop-probe-h-trim-left-frac",
        type=float,
        default=EASYOCR_CROP_PROBE_H_TRIM_LEFT_FRAC,
        help=(
            "EasyOCR horizontal crop: fraction of frame width to discard from the left before OCR probe/strip "
            "(0–0.49; default matches EASYOCR_CROP_PROBE_H_TRIM_LEFT_FRAC)."
        ),
    )
    parser.add_argument(
        "--easyocr-crop-probe-h-trim-right-frac",
        type=float,
        default=EASYOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC,
        help=(
            "EasyOCR horizontal crop: fraction of frame width to discard from the right before OCR probe/strip "
            "(0–0.49; default matches EASYOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC)."
        ),
    )
    parser.add_argument(
        "--easyocr-cleanup-debug-after-step7",
        choices=["on", "off"],
        default="on" if EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 else "off",
        help=(
            "on (default): after successful Step7, delete LOG_DIR/step1_ocr "
            "(frames, cropped.mp4, frame_ocr_raw.jsonl per-frame OCR debug) and "
            "LOG_DIR/easyocr_crop_probe. off: keep those folders for inspection."
        ),
    )
    parser.add_argument(
        "--existing-srt-dir-path",
        default="",
        help=(
            "Thư mục chứa SRT có sẵn. Nếu có {video_stem}.srt thì copy sang "
            "subtitles/{video_stem}.zh.srt và bỏ qua Step1 (Whisper/EasyOCR)."
        ),
    )
    parser.add_argument(
        "--easyocr-max-strip-height-ratio",
        type=float,
        default=EASYOCR_MAX_STRIP_HEIGHT_RATIO,
        help=(
            "Cap OCR band height (hi-lo) to this fraction of frame height; 0 disables. "
            "Default 0.03 (~3%%); subtitle lines are often ~2.5–3%% tall — use 0 with probe+bbox refine if needed."
        ),
    )
    parser.add_argument(
        "--easyocr-text-skip-defaults",
        choices=["on", "off"],
        default="on" if EASYOCR_TEXT_SKIP_DEFAULTS_ON else "off",
        help=(
            "on: apply built-in regex skip list (short UI/watermark lines). "
            "off: only patterns from --easyocr-text-skip-regexes-json."
        ),
    )
    parser.add_argument(
        "--easyocr-text-skip-regexes-json",
        default=None,
        help=(
            "JSON array of extra regex strings; each must full-match a merged OCR block "
            "after clean (see built-ins when --easyocr-text-skip-defaults on)."
        ),
    )
    parser.add_argument(
        "--easyocr-fps",
        type=float,
        default=None,
        help=(
            "Override EasyOCR ffmpeg fps filter (frames/sec). When omitted, uses "
            "1000 / --easyocr-min-duration-ms so the OCR timeline step matches the min cue length "
            "(e.g. 500 ms → 2 FPS, 100 ms → 10 FPS)."
        ),
    )
    parser.add_argument(
        "--easyocr-workers",
        type=int,
        default=EASYOCR_WORKERS,
        help="Parallel OCR worker threads (default 4).",
    )
    parser.add_argument(
        "--easyocr-min-confidence",
        type=float,
        default=EASYOCR_MIN_CONFIDENCE,
        help="Minimum OCR confidence to keep a text result (default 0.5).",
    )
    parser.add_argument(
        "--easyocr-min-duration-ms",
        type=int,
        default=EASYOCR_MIN_DURATION_MS,
        help=(
            "EasyOCR: minimum SRT cue duration (ms) after merge; also sets extract FPS to "
            "1000/this (unless --easyocr-fps is set). Shorter value = denser frame sampling."
        ),
    )
    parser.add_argument(
        "--easyocr-fuzzy-threshold",
        type=float,
        default=EASYOCR_FUZZY_THRESHOLD,
        help="Similarity %% threshold for fuzzy dedup/merge (default 80).",
    )
    parser.add_argument(
        "--easyocr-low-conf-floor",
        type=float,
        default=EASYOCR_LOW_CONF_FLOOR,
        help=(
            f"Confidence floor cho rescue (default {EASYOCR_LOW_CONF_FLOOR}): "
            "frame có conf >= floor nhưng < min-confidence sẽ được xem xét rescue."
        ),
    )
    parser.add_argument(
        "--easyocr-bridge-frames",
        type=int,
        default=EASYOCR_BRIDGE_FRAMES,
        help=(
            f"Số frame lân cận để vote rescue (default {EASYOCR_BRIDGE_FRAMES}). "
            "Xét trong cửa sổ ±N frame quanh frame cần rescue."
        ),
    )
    parser.add_argument(
        "--easyocr-bridge-min-match",
        type=int,
        default=EASYOCR_BRIDGE_MIN_MATCH,
        help=(
            f"Số frame tương đồng tối thiểu để rescue (default {EASYOCR_BRIDGE_MIN_MATCH}). "
            "Nếu >= N frame lân cận có text >=fuzzy-threshold%% giống → rescue."
        ),
    )
    parser.add_argument(
        "--mode",
        choices=["basic", "advance"],
        default="basic",
        help="Step1 VAD/Whisper profile: basic (nhẹ, giọng yếu/ASMR) or advance (stricter thresholds).",
    )
    parser.add_argument("--edge-tts-voice", default=EDGE_TTS_VOICE)
    parser.add_argument("--edge-tts-rate", default=EDGE_TTS_RATE)
    parser.add_argument("--edge-tts-volume", default=EDGE_TTS_VOLUME)
    parser.add_argument("--edge-tts-pitch", default=EDGE_TTS_PITCH)
    parser.add_argument(
        "--step3-tts-engine",
        choices=["edge", "omnivoice"],
        default=STEP3_TTS_ENGINE,
        help="edge=Edge TTS; omnivoice=OmniVoice Vi (pip install omnivoice, khuyến nghị GPU).",
    )
    parser.add_argument(
        "--omnivoice-ref-wav",
        default="",
        help=(
            "Tên file giọng mẫu đặt trong thư mục voice/ (vd: sample.wav). "
            "Khi có giá trị, script sẽ dùng SCRIPT_DIR/voice/<tên_file> cho OMNIVOICE_REF_WAV."
        ),
    )
    parser.add_argument(
        "--omnivoice-ref-text",
        default="",
        help="Transcript khớp file giọng mẫu OmniVoice (OMNIVOICE_REF_TEXT).",
    )
    parser.add_argument(
        "--auto-speed",
        choices=["on", "off"],
        default="on" if STEP3_AUTO_RATE_ENABLED else "off",
        help="Enable/disable dynamic TTS speed boost based on subtitle density.",
    )
    parser.add_argument(
        "--step3-auto-rate-trigger-cps",
        type=float,
        default=STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC,
        help="Target chars/sec for TTS: ramp auto-rate near this value; above it, bonus scales up (when --auto-speed on).",
    )
    parser.add_argument(
        "--step3-auto-rate-bonus-percent",
        type=int,
        default=STEP3_AUTO_RATE_BONUS_PERCENT,
        help="Base bonus percent on edge-tts rate; scaled smoothly before trigger and by density above it.",
    )
    parser.add_argument(
        "--step3-tts-borrow-gap",
        choices=["on", "off"],
        default="on" if STEP3_TTS_BORROW_GAP else "off",
        help="Let TTS extend into silence before the next subtitle (reduces mid-sentence cuts).",
    )
    parser.add_argument(
        "--step3-tts-api-timeout-sec",
        type=float,
        default=STEP3_TTS_API_TIMEOUT_SEC,
        help="Per-request timeout cho edge-tts (save). 0=tắt.",
    )
    parser.add_argument(
        "--step3-tts-max-retry-action",
        choices=["stop", "skip"],
        default=STEP3_TTS_MAX_RETRY_ACTION,
        help="After TTS_RETRY_MAX failed attempts: stop=pipeline error; skip=silent segment and continue.",
    )
    parser.add_argument(
        "--step3-voice-resume",
        choices=["on", "off"],
        default="on" if STEP3_VOICE_RESUME else "off",
        help="on=đọc/ghi checkpoint trong logs/tts_chunks; chỉ gọi TTS cho segment chưa trong list + chưa có part_XXXX.wav (tiết kiệm rate).",
    )
    parser.add_argument(
        "--translation-context",
        default=TRANSLATION_CONTEXT,
        help="Custom context/instructions for Gemini translation. Overrides default Han-Viet prompt.",
    )
    parser.add_argument(
        "--step",
        default=None,
        help="Run only selected steps: N or A,B (inclusive). Example: --step 3 or --step 1,5",
    )

    return parser.parse_args()


def _log_cli_input(args):
    """Log đầy đủ sys.argv và dict argparse đã parse (không cắt chuỗi)."""
    d = vars(args)
    keys = sorted(d.keys())
    if "video" in d:
        keys = ["video"] + [k for k in keys if k != "video"]
    payload = {k: d[k] for k in keys}
    log("CLI args (parsed): " + json.dumps(payload, ensure_ascii=False, default=str))


def apply_cli_config(args):
    global WHISPER_LANGUAGE
    global STEP1_SUBTITLE_SOURCE
    global SUBTITLE_FONT
    global SUBTITLE_FONTSIZE
    global SUBTITLE_PRIMARY_COLOUR
    global SUBTITLE_OUTLINE_COLOUR
    global SUBTITLE_OUTLINE
    global SUBTITLE_SHADOW
    global SUBTITLE_ALIGNMENT
    global SUBTITLE_MARGIN_V
    global SUBTITLE_UPPERCASE
    global SUBTITLE_BG_BLUR_WIDTH_RATIO
    global SUBTITLE_BG_BLUR_HEIGHT
    global SUBTITLE_BG_BLUR_BOTTOM_OFFSET
    global SUBTITLE_BG_BLUR_LUMA_RADIUS
    global SUBTITLE_BG_BLUR_LUMA_POWER
    global SUBTITLE_BG_BLUR_CHROMA_RADIUS
    global SUBTITLE_BG_BLUR_CHROMA_POWER
    global LOGO_FILE
    global MERGE_OUTRO_ENABLED
    global OUTRO_FILE
    global LOGO_WIDTH
    global LOGO_MARGIN_X
    global LOGO_MARGIN_Y
    global LOGO_OPACITY
    global LOGO_ENABLED
    global STEP6_VISUAL_TRANSFORM_ENABLED
    global STEP6_HFLIP
    global STEP6_ZOOM_PERCENT
    global STEP6_EQ_SATURATION
    global STEP6_EQ_CONTRAST
    global STEP6_UNSHARP
    global OUTPUT_METADATA_ENABLED
    global OUTPUT_METADATA_FROM_FILENAME
    global OUTPUT_METADATA_TITLE
    global OUTPUT_METADATA_ARTIST
    global OUTPUT_METADATA_COMMENT
    global ORIGINAL_AUDIO_VOLUME
    global NARRATION_AUDIO_VOLUME
    global PREPROCESS_SPEED
    global EXPORT_RESOLUTION
    global VIDEO_CODEC
    global SPEED_VIDEO
    global STEP4_MERGE_SPEED
    global EDGE_TTS_VOICE
    global STEP3_TTS_ENGINE
    global STEP3_AUTO_RATE_ENABLED
    global STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC
    global STEP3_AUTO_RATE_BONUS_PERCENT
    global STEP3_TTS_BORROW_GAP
    global STEP3_TTS_API_TIMEOUT_SEC
    global STEP3_TTS_MAX_RETRY_ACTION
    global STEP3_VOICE_RESUME
    global TRANSLATION_CONTEXT
    WHISPER_LANGUAGE = str(args.whisper_language).strip() or None
    STEP1_SUBTITLE_SOURCE = (
        str(args.step1_subtitle_source or STEP1_SUBTITLE_SOURCE).strip().lower()
    )
    global EDGE_TTS_RATE
    global EDGE_TTS_VOLUME
    global EDGE_TTS_PITCH
    global OMNIVOICE_REF_WAV
    global OMNIVOICE_REF_TEXT
    global STEP1_MIN_SILENCE_MS
    global STEP1_MIN_SPEECH_MS
    global STEP1_SPEECH_PAD_MS
    global STEP1_NO_SPEECH_THRESHOLD
    global STEP1_LOGPROB_THRESHOLD
    global STEP1_CONDITION_ON_PREVIOUS_TEXT
    global EASYOCR_LANG
    global EASYOCR_SUBTITLE_CROP_BAND_HI
    global EASYOCR_FPS
    global EASYOCR_WORKERS
    global EASYOCR_MIN_CONFIDENCE
    global EASYOCR_MIN_DURATION_MS
    global EASYOCR_FUZZY_THRESHOLD
    global EASYOCR_GPU
    global EASYOCR_LOW_CONF_FLOOR
    global EASYOCR_BRIDGE_FRAMES
    global EASYOCR_BRIDGE_MIN_MATCH
    global EASYOCR_WHITE_THRESH
    global EASYOCR_LUMA_SUPPRESS
    global EASYOCR_GRAY_CONTRAST
    global EASYOCR_GRAY_BRIGHTNESS
    global EASYOCR_GRAY_GAMMA
    global EASYOCR_HISTEQ_STRENGTH
    global EASYOCR_GRAY_INVERT
    global EASYOCR_UNSHARP
    global EASYOCR_CLEANUP_DEBUG_AFTER_STEP7
    global EXISTING_SRT_DIR_PATH
    global EASYOCR_MAX_STRIP_HEIGHT_RATIO
    global EASYOCR_TEXT_SKIP_DEFAULTS_ON
    global EASYOCR_TEXT_SKIP_REGEXES_JSON
    global PADDLEOCR_LANG
    global PADDLEOCR_USE_GPU
    global PADDLEOCR_SUBTITLE_CROP_BAND_HI
    global PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC
    global PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC
    global PADDLEOCR_MIN_CONFIDENCE
    global PADDLEOCR_SCAN_FPS
    global PADDLEOCR_FRAMEDIFF_THRESHOLD
    global PADDLEOCR_BATCH_SIZE
    global PADDLEOCR_MIN_DURATION_MS
    global PADDLEOCR_FUZZY_THRESHOLD
    global PADDLEOCR_MAX_STRIP_HEIGHT_RATIO
    global PADDLEOCR_CLEANUP_DEBUG_AFTER_STEP7
    global PADDLEOCR_WATERMARK_BLACKLIST
    global PADDLEOCR_WATERMARK_MIN_FRAMES

    SUBTITLE_FONT = args.subtitle_font
    SUBTITLE_FONTSIZE = args.subtitle_fontsize
    SUBTITLE_PRIMARY_COLOUR = normalize_ass_colour(args.subtitle_primary_colour)
    SUBTITLE_OUTLINE_COLOUR = normalize_ass_colour(args.subtitle_outline_colour)
    SUBTITLE_OUTLINE = args.subtitle_outline
    SUBTITLE_SHADOW = args.subtitle_shadow
    SUBTITLE_ALIGNMENT = args.subtitle_alignment
    SUBTITLE_MARGIN_V = args.subtitle_margin_v
    SUBTITLE_UPPERCASE = args.subtitle_uppercase == "on"

    SUBTITLE_BG_BLUR_WIDTH_RATIO = args.subtitle_bg_blur_width_ratio
    SUBTITLE_BG_BLUR_HEIGHT = args.subtitle_bg_blur_height
    SUBTITLE_BG_BLUR_BOTTOM_OFFSET = args.subtitle_bg_blur_bottom_offset
    SUBTITLE_BG_BLUR_LUMA_RADIUS = args.subtitle_bg_blur_luma_radius
    SUBTITLE_BG_BLUR_LUMA_POWER = args.subtitle_bg_blur_luma_power
    SUBTITLE_BG_BLUR_CHROMA_RADIUS = args.subtitle_bg_blur_chroma_radius
    SUBTITLE_BG_BLUR_CHROMA_POWER = args.subtitle_bg_blur_chroma_power

    LOGO_FILE = args.logo_file
    LOGO_WIDTH = args.logo_width
    LOGO_MARGIN_X = args.logo_margin_x
    LOGO_MARGIN_Y = args.logo_margin_y
    LOGO_OPACITY = args.logo_opacity
    LOGO_ENABLED = args.logo_enabled == "on"
    MERGE_OUTRO_ENABLED = args.merge_outro == "on"
    OUTRO_FILE = str(args.outro_file or "").strip()

    STEP6_VISUAL_TRANSFORM_ENABLED = args.step6_visual_transform == "on"
    STEP6_HFLIP = args.step6_hflip == "on"
    STEP6_ZOOM_PERCENT = float(args.step6_zoom_percent)
    STEP6_EQ_SATURATION = float(args.step6_eq_saturation)
    STEP6_EQ_CONTRAST = float(args.step6_eq_contrast)
    STEP6_UNSHARP = str(args.step6_unsharp).strip() or "5:5:0.8:3:3:0.0"

    OUTPUT_METADATA_ENABLED = args.output_metadata == "on"
    OUTPUT_METADATA_FROM_FILENAME = args.metadata_from_filename == "on"
    OUTPUT_METADATA_TITLE = str(args.metadata_title or "").strip()
    OUTPUT_METADATA_ARTIST = str(args.metadata_artist or "").strip()
    OUTPUT_METADATA_COMMENT = str(args.metadata_comment or "").strip()

    ORIGINAL_AUDIO_VOLUME = args.original_volume
    NARRATION_AUDIO_VOLUME = args.narration_volume
    PREPROCESS_SPEED = float(args.preprocess_speed)
    EXPORT_RESOLUTION = str(args.export_resolution or "source").strip().lower()
    VIDEO_CODEC = _normalize_video_codec_key(getattr(args, "video_codec", VIDEO_CODEC))
    SPEED_VIDEO = args.speed_video
    STEP4_MERGE_SPEED = float(args.step4_merge_speed)

    EDGE_TTS_VOICE = args.edge_tts_voice
    EDGE_TTS_RATE = resolve_base_tts_rate(args.edge_tts_rate)
    EDGE_TTS_VOLUME = args.edge_tts_volume
    EDGE_TTS_PITCH = args.edge_tts_pitch
    STEP3_TTS_ENGINE = str(args.step3_tts_engine or "edge").strip().lower() or "edge"
    omnivoice_ref_wav_name = str(getattr(args, "omnivoice_ref_wav", "") or "").strip()
    if omnivoice_ref_wav_name:
        OMNIVOICE_REF_WAV = str(SCRIPT_DIR / "voice" / omnivoice_ref_wav_name)
    omnivoice_ref_text = str(getattr(args, "omnivoice_ref_text", "") or "").strip()
    if omnivoice_ref_text:
        OMNIVOICE_REF_TEXT = omnivoice_ref_text
    STEP3_AUTO_RATE_ENABLED = args.auto_speed == "on"
    STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC = float(args.step3_auto_rate_trigger_cps)
    STEP3_AUTO_RATE_BONUS_PERCENT = int(args.step3_auto_rate_bonus_percent)
    STEP3_TTS_BORROW_GAP = args.step3_tts_borrow_gap == "on"
    STEP3_TTS_API_TIMEOUT_SEC = float(args.step3_tts_api_timeout_sec)
    STEP3_TTS_MAX_RETRY_ACTION = (
        str(args.step3_tts_max_retry_action or "stop").strip().lower()
    )
    STEP3_VOICE_RESUME = args.step3_voice_resume == "on"
    TRANSLATION_CONTEXT = args.translation_context or ""

    prof = STEP1_PROFILES[args.mode]
    STEP1_VAD_THRESHOLD = prof["vad_threshold"]
    STEP1_MIN_SILENCE_MS = prof["min_silence_ms"]
    STEP1_MIN_SPEECH_MS = prof["min_speech_ms"]
    STEP1_SPEECH_PAD_MS = prof["speech_pad_ms"]
    STEP1_NO_SPEECH_THRESHOLD = prof["no_speech_threshold"]
    STEP1_LOGPROB_THRESHOLD = prof["logprob_threshold"]
    STEP1_CONDITION_ON_PREVIOUS_TEXT = prof["condition_on_previous_text"]

    if args.easyocr_lang:
        EASYOCR_LANG = [s.strip() for s in args.easyocr_lang.split(",") if s.strip()]
    EASYOCR_SUBTITLE_CROP_BAND_HI = float(args.easyocr_crop_band_hi)
    EASYOCR_CROP_PROBE_H_TRIM_LEFT_FRAC = max(
        0.0,
        min(0.49, float(args.easyocr_crop_probe_h_trim_left_frac)),
    )
    EASYOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC = max(
        0.0,
        min(0.49, float(args.easyocr_crop_probe_h_trim_right_frac)),
    )
    EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 = (
        args.easyocr_cleanup_debug_after_step7 == "on"
    )
    EXISTING_SRT_DIR_PATH = str(getattr(args, "existing_srt_dir_path", "") or "").strip()
    mstrip = float(getattr(args, "easyocr_max_strip_height_ratio", 0) or 0)
    if mstrip > 1.0 and mstrip <= 100.0:
        mstrip = mstrip / 100.0
    EASYOCR_MAX_STRIP_HEIGHT_RATIO = max(0.0, min(1.0, mstrip))
    EASYOCR_TEXT_SKIP_DEFAULTS_ON = getattr(
        args, "easyocr_text_skip_defaults", "on"
    ) == "on"
    rj = getattr(args, "easyocr_text_skip_regexes_json", None)
    EASYOCR_TEXT_SKIP_REGEXES_JSON = (
        str(rj).strip() if rj is not None and str(rj).strip() else "[]"
    )
    EASYOCR_WORKERS = int(args.easyocr_workers)
    EASYOCR_MIN_CONFIDENCE = float(args.easyocr_min_confidence)
    EASYOCR_MIN_DURATION_MS = max(1, int(args.easyocr_min_duration_ms))
    if args.easyocr_fps is not None:
        EASYOCR_FPS = max(0.01, float(args.easyocr_fps))
    else:
        EASYOCR_FPS = 1000.0 / float(EASYOCR_MIN_DURATION_MS)
    EASYOCR_FUZZY_THRESHOLD = float(args.easyocr_fuzzy_threshold)
    EASYOCR_LOW_CONF_FLOOR = max(
        0.0, float(getattr(args, "easyocr_low_conf_floor", EASYOCR_LOW_CONF_FLOOR))
    )
    EASYOCR_BRIDGE_FRAMES = max(
        0, int(getattr(args, "easyocr_bridge_frames", EASYOCR_BRIDGE_FRAMES))
    )
    EASYOCR_BRIDGE_MIN_MATCH = max(
        1, int(getattr(args, "easyocr_bridge_min_match", EASYOCR_BRIDGE_MIN_MATCH))
    )

    if EASYOCR_WHITE_THRESH > 0:
        _mode_str = f"white_thresh={EASYOCR_WHITE_THRESH} (binary: white text / black bg)"
    elif EASYOCR_LUMA_SUPPRESS > 1e-9:
        _mode_str = f"luma_suppress={EASYOCR_LUMA_SUPPRESS:.3f} (color frames)"
    else:
        _mode_str = (
            f"gray_eq contrast={EASYOCR_GRAY_CONTRAST:.3f} brightness={EASYOCR_GRAY_BRIGHTNESS:.3f} "
            f"gamma={EASYOCR_GRAY_GAMMA:.3f} histeq={EASYOCR_HISTEQ_STRENGTH} "
            f"gray_invert={'on' if EASYOCR_GRAY_INVERT else 'off'} unsharp={EASYOCR_UNSHARP or 'off'}"
        )
    log(
        "Step1 OCR config: "
        f"easyocr_min_duration_ms={EASYOCR_MIN_DURATION_MS} "
        f"easyocr_fps={EASYOCR_FPS:.4g} "
        f"{_mode_str} "
        f"({'override' if args.easyocr_fps is not None else '1000/min-duration'})"
    )

    # PaddleOCR CLI config
    if getattr(args, "paddleocr_lang", None):
        PADDLEOCR_LANG = str(args.paddleocr_lang).strip()
    PADDLEOCR_USE_GPU = getattr(args, "paddleocr_use_gpu", "on") == "on"
    PADDLEOCR_SUBTITLE_CROP_BAND_HI = float(getattr(args, "paddleocr_crop_band_hi", PADDLEOCR_SUBTITLE_CROP_BAND_HI))
    PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC = max(
        0.0, min(0.49, float(getattr(args, "paddleocr_crop_probe_h_trim_left_frac", PADDLEOCR_CROP_PROBE_H_TRIM_LEFT_FRAC)))
    )
    PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC = max(
        0.0, min(0.49, float(getattr(args, "paddleocr_crop_probe_h_trim_right_frac", PADDLEOCR_CROP_PROBE_H_TRIM_RIGHT_FRAC)))
    )
    PADDLEOCR_MIN_CONFIDENCE = float(getattr(args, "paddleocr_min_confidence", PADDLEOCR_MIN_CONFIDENCE))
    PADDLEOCR_SCAN_FPS = max(0.1, float(getattr(args, "paddleocr_scan_fps", PADDLEOCR_SCAN_FPS)))
    PADDLEOCR_FRAMEDIFF_THRESHOLD = float(getattr(args, "paddleocr_framediff_threshold", PADDLEOCR_FRAMEDIFF_THRESHOLD))
    PADDLEOCR_BATCH_SIZE = max(1, int(getattr(args, "paddleocr_batch_size", PADDLEOCR_BATCH_SIZE)))
    PADDLEOCR_MIN_DURATION_MS = max(1, int(getattr(args, "paddleocr_min_duration_ms", PADDLEOCR_MIN_DURATION_MS)))
    PADDLEOCR_FUZZY_THRESHOLD = float(getattr(args, "paddleocr_fuzzy_threshold", PADDLEOCR_FUZZY_THRESHOLD))
    _pstrip = float(getattr(args, "paddleocr_max_strip_height_ratio", PADDLEOCR_MAX_STRIP_HEIGHT_RATIO) or 0)
    if _pstrip > 1.0 and _pstrip <= 100.0:
        _pstrip = _pstrip / 100.0
    PADDLEOCR_MAX_STRIP_HEIGHT_RATIO = max(0.0, min(1.0, _pstrip))
    PADDLEOCR_CLEANUP_DEBUG_AFTER_STEP7 = getattr(args, "paddleocr_cleanup_debug_after_step7", "on") == "on"
    _wm_bl = getattr(args, "paddleocr_watermark_blacklist", None)
    if _wm_bl is not None:
        PADDLEOCR_WATERMARK_BLACKLIST = _wm_bl
    _wm_mf = getattr(args, "paddleocr_watermark_min_frames", None)
    if _wm_mf is not None:
        PADDLEOCR_WATERMARK_MIN_FRAMES = int(_wm_mf)


def parse_step_range(step_arg, min_step=1, max_step=6):
    if step_arg is None:
        return min_step, max_step

    raw = str(step_arg).strip()
    if raw.startswith("[") and raw.endswith("]"):
        raw = raw[1:-1].strip()
    if not raw:
        raise ValueError("--step is empty. Use N or A,B (example: --step 1,5).")

    if "," in raw:
        parts = [p.strip() for p in raw.split(",")]
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise ValueError("--step must be N or A,B (example: --step 1,5).")
        start_step = int(parts[0])
        end_step = int(parts[1])
    else:
        start_step = int(raw)
        end_step = int(raw)

    if start_step < min_step or end_step > max_step:
        raise ValueError(
            f"--step out of range. Supported steps: {min_step}..{max_step}."
        )
    if start_step > end_step:
        raise ValueError("--step range invalid: start must be <= end.")
    return start_step, end_step


def require_ready(path, label):
    p = Path(path)
    if not file_ready(p):
        raise RuntimeError(f"{label} missing: {p}")
    return p


def _cleanup_easyocr_artifacts_after_step7():
    """Sau Step7 xong: xóa thư mục tạm EasyOCR (step1_ocr, easyocr_crop_probe dưới LOG_DIR)."""
    if not EASYOCR_CLEANUP_DEBUG_AFTER_STEP7:
        return
    for name in ("step1_ocr", "easyocr_crop_probe"):
        path = LOG_DIR / name
        if not path.exists():
            continue
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            log(f"Step7 cleanup: không xóa hết được {path} (quyền/ghi volume).")
        else:
            log(f"Step7 cleanup: đã xóa {name} ({path}).")


def _cleanup_paddleocr_artifacts_after_step7():
    """Sau Step7 xong: xóa thư mục tạm PaddleOCR (step1_paddleocr, paddleocr_crop_probe)."""
    if not PADDLEOCR_CLEANUP_DEBUG_AFTER_STEP7:
        return
    for name in ("step1_paddleocr", "paddleocr_crop_probe"):
        path = LOG_DIR / name
        if not path.exists():
            continue
        shutil.rmtree(path, ignore_errors=True)
        if path.exists():
            log(f"Step7 cleanup: không xóa hết được {path} (quyền/ghi volume).")
        else:
            log(f"Step7 cleanup: đã xóa {name} ({path}).")


def _run_step6_and_finalize(ass, tm_video, video_path, skip_voice_step):
    require_ready(ass, "Step6 input sub.ass")
    if skip_voice_step:
        video_for_render = video_path
    else:
        video_for_render = require_ready(tm_video, "Step6 input merged video (_tm.mp4)")
    # Re-apply subtitle style even when ASS is reused from cache.
    update_ass_default_style(ass)
    final = step6_render(video_for_render, ass)
    final = step7_finalize(final)
    if not file_ready(final):
        raise RuntimeError("Final video render failed.")
    if MERGE_OUTRO_ENABLED and OUTRO_FILE:
        final = step7_merge_outro(final)
    _cleanup_easyocr_artifacts_after_step7()
    _cleanup_paddleocr_artifacts_after_step7()
    if not skip_voice_step and tm_video.is_file():
        tm_video.unlink()
    if ass.is_file():
        ass.unlink()
    done_path = publish_deliverables(preferred=final) or final
    log(f"DONE: {done_path}")
    return done_path


def work_roots_use_staging_split() -> bool:
    return WORK_STAGING_ROOT.resolve() != WORK_OUTPUT_ROOT.resolve()


def _init_work_paths(work_name: str) -> None:
    global WORK_NAME, WORK_OUTPUT_DIR, WORK_STAGING_DIR, WORK_DIR
    global VIDEO_DIR, SUBTITLE_DIR, LOG_DIR, LOG_PATH

    WORK_NAME = work_name
    WORK_OUTPUT_DIR = WORK_OUTPUT_ROOT / work_name
    WORK_STAGING_DIR = WORK_STAGING_ROOT / work_name
    WORK_DIR = WORK_STAGING_DIR
    VIDEO_DIR = WORK_STAGING_DIR / "videos"
    SUBTITLE_DIR = WORK_STAGING_DIR / "subtitles"
    LOG_DIR = WORK_STAGING_DIR / "logs"
    LOG_PATH = LOG_DIR / "pipeline.log"
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    SUBTITLE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)


def _stage_pipeline_input(video_path: Path) -> Path:
    """Copy input sang staging (/home) khi tách khỏi output (/mnt/c)."""
    if not work_roots_use_staging_split():
        return video_path
    staged = VIDEO_DIR / f"{WORK_NAME}_input{video_path.suffix.lower()}"
    if (not staged.is_file()) or (
        video_path.stat().st_mtime > staged.stat().st_mtime
    ):
        log(f"Staging input: {video_path} -> {staged}")
        shutil.copy2(video_path, staged)
    return staged


def publish_deliverables(preferred: Path | None = None) -> Path | None:
    """
    Đồng bộ artifact cuối staging -> TRANSLATE_WORK_ROOT (vd. /mnt/c).
    No-op khi staging == output.
    """
    if not work_roots_use_staging_split():
        return preferred.resolve() if preferred and preferred.is_file() else None

    out_base = WORK_OUTPUT_DIR
    out_videos = out_base / "videos"
    out_subs = out_base / "subtitles"
    out_videos.mkdir(parents=True, exist_ok=True)
    out_subs.mkdir(parents=True, exist_ok=True)

    published_final = None
    for name in (f"{WORK_NAME}_vs_tm_outro.mp4", f"{WORK_NAME}_vs_tm.mp4"):
        src = VIDEO_DIR / name
        if src.is_file():
            dst = out_videos / name
            shutil.copy2(src, dst)
            published_final = dst

    for src in (get_zh_srt_path(), get_vi_srt_path()):
        if src.is_file():
            shutil.copy2(src, out_subs / src.name)

    if published_final:
        log(f"Published deliverables -> {out_base}")
        return published_final.resolve()

    if preferred and preferred.is_file():
        try:
            rel = preferred.resolve().relative_to(WORK_STAGING_DIR.resolve())
        except ValueError:
            return preferred.resolve()
        dst = (out_base / rel).resolve()
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(preferred, dst)
        log(f"Published {dst}")
        return dst

    return None


# ==============================
# MAIN PIPELINE
# ==============================


def run_pipeline(video, step_arg=None):
    global WORK_NAME, WORK_DIR, VIDEO_DIR, SUBTITLE_DIR, LOG_DIR, LOG_PATH
    video_path = Path(video).resolve()
    if not file_ready(video_path):
        raise FileNotFoundError(f"Input video not found: {video_path}")

    _init_work_paths(video_path.stem)
    if work_roots_use_staging_split():
        log(f"Work staging: {WORK_STAGING_DIR}")
        log(f"Work output:   {WORK_OUTPUT_DIR}")

    preflight_checks()
    start_step, end_step = parse_step_range(step_arg)

    pipeline_input = _stage_pipeline_input(video_path)
    pre_out = VIDEO_DIR / f"{WORK_NAME}_pre.mp4"
    if abs(float(PREPROCESS_SPEED) - 1.0) > 1e-6:
        pipeline_video_path = get_or_run(
            pre_out,
            "Step0",
            step0_preprocess_speed,
            pipeline_input,
        )
    else:
        pipeline_video_path = pipeline_input

    video_duration_ms = get_media_duration_ms(pipeline_video_path)
    dur_s = (video_duration_ms / 1000.0) if video_duration_ms else None
    log(
        f"Pipeline steps {start_step}..{end_step}"
        + (f", input ~{dur_s:.1f}s" if dur_s is not None else " (duration unknown)")
    )

    def step_enabled(step_no):
        return start_step <= step_no <= end_step

    zh_srt = get_zh_srt_path()
    vi_srt = get_vi_srt_path()
    voice = VIDEO_DIR / f"{WORK_NAME}_voice.wav"
    tm_video = VIDEO_DIR / f"{WORK_NAME}_tm.mp4"
    ass = SUBTITLE_DIR / "sub.ass"
    final = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    last_output = None

    def run_step(step_no, step_name, fn):
        try:
            return fn()
        except Exception as exc:
            raise RuntimeError(
                f"[STEP_{step_no}_FAILED] {step_name} failed: {exc}"
            ) from exc

    if step_enabled(1):
        prefetched = _try_prefetch_step1_zh_srt_from_existing_dir()
        if prefetched is not None:
            zh_srt = prefetched
        else:
            zh_srt = run_step(
                1,
                "Step1",
                lambda: get_or_run(
                    zh_srt, "Step1", step1_transcribe, pipeline_video_path
                ),
            )
        last_output = zh_srt

    if step_enabled(2):
        vi_srt = run_step(
            2,
            "Step2",
            lambda: (
                require_ready(zh_srt, "Step2 input zh subtitle"),
                get_or_run(vi_srt, "Step2", step2_translate_srt, zh_srt),
            )[1],
        )
        last_output = vi_srt

    if SKIP_VOICE_STEP:
        if step_enabled(3) or step_enabled(4):
            log("Skip voice steps enabled: Step3/Step4 are skipped.")
    else:
        if step_enabled(3):
            voice = run_step(
                3,
                "Step3",
                lambda: (
                    require_ready(vi_srt, "Step3 input vi subtitle"),
                    get_or_run(
                        voice,
                        "Step3",
                        step3_generate_voice_from_srt,
                        vi_srt,
                        video_duration_ms,
                    ),
                )[1],
            )
            last_output = voice
        if step_enabled(4):
            tm_video = run_step(
                4,
                "Step4",
                lambda: (
                    require_ready(voice, "Step4 input voice.wav"),
                    get_or_run(tm_video, "Step4", step4_merge_audio, pipeline_video_path, voice),
                )[1],
            )
            last_output = tm_video

    if step_enabled(5):
        ass = run_step(
            5,
            "Step5",
            lambda: (
                require_ready(vi_srt, "Step5 input vi subtitle"),
                get_or_run(ass, "Step5", step5_convert_ass, vi_srt),
            )[1],
        )
        last_output = ass

    if step_enabled(6):
        final = run_step(
            6,
            "Step6",
            lambda: _run_step6_and_finalize(
                ass=ass,
                tm_video=tm_video,
                video_path=pipeline_video_path,
                skip_voice_step=SKIP_VOICE_STEP,
            ),
        )
        last_output = final
    else:
        log("Stopped before Step6 by --step option.")

    published = publish_deliverables(
        preferred=Path(last_output) if last_output else None,
    )
    if published is not None:
        return str(published)
    return last_output


# ==============================
# ENTRY
# ==============================

if __name__ == "__main__":
    args = parse_cli_args()
    _log_cli_input(args)
    apply_cli_config(args)
    try:
        run_pipeline(args.video, args.step)
    except Exception as e:
        log(f"ERROR: {e}")
        log(traceback.format_exc())
        raise
