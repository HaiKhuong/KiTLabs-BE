import argparse
import json
import os
import re
import shutil
import subprocess
import time
import asyncio
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

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

from google import genai
from tqdm import tqdm

# ==============================
# CONFIG
# ==============================

WHISPER_MODEL = "large-v3"
WHISPER_LANGUAGE = "zh"
STEP1_SUBTITLE_SOURCE = "embedded"
GEMINI_MODEL_NAME = "gemini-2.5-flash"
EDGE_TTS_VOICE = "vi-VN-HoaiMyNeural"
EDGE_TTS_RATE = "+30%"
EDGE_TTS_VOLUME = "+10%"
EDGE_TTS_PITCH = "+20Hz"
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
SCRIPT_DIR = Path(__file__).resolve().parent

WORK_ROOT = Path("/mnt/c/Users/haikh/Videos/VideoVietsub/videos")
WORK_NAME = "default"
WORK_DIR = WORK_ROOT / WORK_NAME
VIDEO_DIR = WORK_DIR / "videos"
SUBTITLE_DIR = WORK_DIR / "subtitles"
LOG_DIR = WORK_DIR / "logs"
LOG_PATH = LOG_DIR / "pipeline.log"
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
# Step 6: optional visual pass before subtitle (hflip, zoom, eq, unsharp). Bật bằng --step6-visual-transform on.
STEP6_VISUAL_TRANSFORM_ENABLED = True
STEP6_HFLIP = True
STEP6_ZOOM_PERCENT = 6.0  # 5–7: phóng nhẹ rồi crop giữa để lệch logo góc
STEP6_EQ_SATURATION = 1.1
STEP6_EQ_CONTRAST = 1.03
# ffmpeg unsharp: luma WxH:amount:chroma WxH:amount
STEP6_UNSHARP = "5:5:0.8:3:3:0.0"
ORIGINAL_AUDIO_VOLUME = 0.1
NARRATION_AUDIO_VOLUME = 1.0
# Step4: tốc độ trước khi merge (1.0 = copy video, không setpts). Đổi tốc 0.97 nên dùng --speed-video ở Step7.
STEP4_MERGE_SPEED = 1.0
# Step7: sau render phụ đề (_vs_tm), áp dụng setpts + atempo lên file cuối (vd 0.97 = chậm ~3%).
SPEED_VIDEO = 0.97
# Xuất MP4: xóa metadata nguồn (-map_metadata -1) và ghi Title/Artist/Comment kênh. Bật: --output-metadata on.
OUTPUT_METADATA_ENABLED = True
# True: title/artist/comment = stem file đầu ra (vd. Ten_vs_tm từ Ten_vs_tm.mp4). False: dùng 3 biến bên dưới.
OUTPUT_METADATA_FROM_FILENAME = True
OUTPUT_METADATA_TITLE = "Vạn Giới Vietsub"
OUTPUT_METADATA_ARTIST = "Vạn Giới Vietsub"
OUTPUT_METADATA_COMMENT = "Vạn Giới Vietsub"

STEP1_VAD_FILTER = True  # Nếu False thì sẽ không dùng 4 key phía dưới
# Mặc định CLI: --mode basic (nhẹ, giọng nhỏ/ASMR) hoặc --mode advance (khắc khe hơn). Có thể ghi đè từng tham số.
# Override: --mode, --step1-vad-threshold, --step1-min-silence-ms, --step1-min-speech-ms, --step1-speech-pad-ms,
#           --step1-no-speech-threshold, --step1-logprob-threshold, --step1-condition-on-previous-text
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
EASYOCR_FPS = 2  # frame extraction rate for OCR
EASYOCR_WORKERS = 4  # parallel OCR threads
EASYOCR_MIN_CONFIDENCE = 0.5  # discard OCR results below this confidencee
EASYOCR_FUZZY_THRESHOLD = 80  # % similarity threshold for dedup/merge
EASYOCR_MIN_DURATION_MS = 100  # minimum subtitle display duration (ms)
EASYOCR_MERGE_GAP_MS = 200  # merge adjacent similar blocks within this gap (ms)
EASYOCR_GPU = True
# Sau crop dải đáy: grayscale + ffmpeg eq (cùng tham số cho probe-score OpenCV).
# brightness âm (vd -0.06 … -0.12) làm tối, thường giúp giảm dính watermark/logo sáng; gamma>1 tối midtone.
EASYOCR_GRAY_CONTRAST = 2.0
EASYOCR_GRAY_BRIGHTNESS = 0.05
EASYOCR_GRAY_GAMMA = 1.0
# Giới hạn độ cao dải OCR (hi−lo) so với chiều cao khung; 0 = không chặn (vd 0.05 = tối đa 5%).
EASYOCR_MAX_STRIP_HEIGHT_RATIO = 0.05
# Bỏ qua block SRT sau merge nếu fullmatch regex (sau clean_text).
EASYOCR_TEXT_SKIP_DEFAULTS_ON = True
EASYOCR_TEXT_SKIP_REGEXES_JSON = "[]"
_EASYOCR_SKIP_COMPILED = []  # list[re.Pattern], rebuild trong apply_cli_config

EASYOCR_BUILTIN_SKIP_REGEXES = (
    r"(?i)^\s*(订阅|点赞|收藏|分享|转发|AlCheng动漫)\s*$",
    r"(?i)^\s*会员\s*\d*\s*$",
    r"(?i)^\s*温馨提示\s*$",
    r"^\s*\d{1,2}:\d{2}(:\d{2})?\s*[-–~至]\s*\d{1,2}:\d{2}(:\d{2})?\s*$",
)
# Sau Step7: xóa LOG_DIR/step1_ocr và LOG_DIR/easyocr_crop_probe (--easyocr-cleanup-debug-after-step7 off để giữ).
EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 = True

STEP1_MAX_SUBTITLE_CHARS = 22  # số ký tự tối đa mỗi câu sau tách.
STEP1_MIN_SUBTITLE_DURATION_MS = 280  # thời gian hiển thị tối thiểu mỗi câu.
STEP1_SHORT_TEXT_MAX_CHARS = 14  # ngưỡng để coi là “câu ngắn”.
STEP1_MIN_CHARS_PER_SEC = (
    2.2  # nếu cps thấp hơn ngưỡng, coi là câu ngắn bị dính khoảng trống.
)
STEP1_TARGET_CHARS_PER_SEC = (
    5.5  # tốc độ mục tiêu khi siết lại timing câu ngắn (giữ đuôi, cắt đầu).
)

# Step1 VAD/Whisper presets (--mode basic|advance). Per-flag CLI overrides still win when passed.
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


def log(message):
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


def emit_db_status(step_no, state, message=""):
    """Structured status marker for backend parser."""
    clean_message = str(message or "").replace("\n", " ").strip()
    log(f"DB_STATUS|step={int(step_no)}|state={state}|message={clean_message}")


def file_ready(path):
    p = Path(path)
    return p.exists() and p.stat().st_size > 0


def retry_call(fn, label, max_retry=RETRY_MAX, base_delay=1.5, db_step=None):
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
            if db_step is not None:
                emit_db_status(
                    int(db_step),
                    "running",
                    f"{label} thử lại ({attempt}/{max_retry})…",
                )
            time.sleep(delay)


def step3_tts_retry(
    run_fn, label, max_retry=TTS_RETRY_MAX, base_delay=1.5, db_step=None
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
            if db_step is not None:
                emit_db_status(
                    int(db_step),
                    "running",
                    f"Step3 TTS thử lại ({attempt}/{max_retry})…",
                )
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
    """Trả về set chỉ số i (enumerate blocks) đã có WAV để bỏ qua edge-tts."""
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


def build_visual_transform_filters():
    """hflip → scale+crop (zoom ~STEP6_ZOOM_PERCENT%) → eq → unsharp. Chuỗi filter không gồm nhãn [0:v]."""
    if not STEP6_VISUAL_TRANSFORM_ENABLED:
        return ""
    parts = []
    if STEP6_HFLIP:
        parts.append("hflip")
    zp = float(STEP6_ZOOM_PERCENT)
    if zp > 0.01:
        zf = 1.0 + zp / 100.0
        # Lý do khung có thể lệch vài pixel (vd 2560→2558): scale làm tròn iw*zf / ih*zf
        # sang số nguyên; crop dùng iw/zf trên kích thước đã scale nên (iw*zf)/zf ≠ iw.
        parts.append(f"scale=iw*{zf:.6f}:ih*{zf:.6f}")
        parts.append(f"crop=iw/{zf:.6f}:ih/{zf:.6f}:(iw-ow)/2:(ih-oh)/2")
    parts.append(
        f"eq=saturation={float(STEP6_EQ_SATURATION):.4f}:contrast={float(STEP6_EQ_CONTRAST):.4f}"
    )
    parts.append(f"unsharp={STEP6_UNSHARP}")
    return ",".join(parts)


def build_subtitle_filter(ass_path):
    tail = build_subtitle_filter_tail(ass_path)
    if not STEP6_VISUAL_TRANSFORM_ENABLED:
        return tail
    vt = build_visual_transform_filters()
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
    if use_gpu:
        return [
            FFMPEG_BIN,
            "-y",
            *input_args,
            filter_arg_key,
            filter_arg_value,
            *map_args,
            "-c:v",
            "h264_nvenc",
            "-preset",
            "p4",
            "-cq",
            "23",
            "-c:a",
            "copy",
            *meta,
            str(out_path),
        ]
    return [
        FFMPEG_BIN,
        "-y",
        *input_args,
        filter_arg_key,
        filter_arg_value,
        *map_args,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "23",
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








def _easyocr_crop_band_strip_bgr(img_bgr, band_lo, band_hi):
    """Cắt dải dọc [band_lo, band_hi] tính từ đáy khung (band_lo < band_hi)."""
    ih, iw = img_bgr.shape[:2]
    if ih < 4 or iw < 4:
        return None
    lo = float(band_lo)
    hi = float(band_hi)
    if hi <= lo + 1e-9:
        return None
    top = int(round(ih * (1.0 - hi)))
    h = int(round(ih * (hi - lo)))
    h = max(2, min(h, ih - top))
    if h < 2 or top >= ih:
        return None
    return img_bgr[top : top + h, :]


def _easyocr_crop_ffmpeg_vf(band_lo, band_hi):
    """filter crop cho dải đáy [band_lo, band_hi] từ đáy (inner→outer)."""
    lo = float(band_lo)
    hi = float(band_hi)
    if hi <= lo + 1e-9:
        raise ValueError("easyocr crop band: need band_hi > band_lo")
    dh = hi - lo
    y_from_top = 1.0 - hi
    c = float(EASYOCR_GRAY_CONTRAST)
    b = float(EASYOCR_GRAY_BRIGHTNESS)
    g = float(EASYOCR_GRAY_GAMMA)
    return (
        f"crop=iw:ih*{dh:.6f}:0:ih*{y_from_top:.6f},"
        f"format=gray,eq=contrast={c:.6f}:brightness={b:.6f}:gamma={g:.6f}"
    )


def _easyocr_probe_timestamps_sec(duration_ms, n_frames):
    """Spread sample times across the file; avoid the very last frames."""
    n = max(1, int(n_frames))
    if duration_ms and duration_ms > 8000:
        d_sec = duration_ms / 1000.0
        cap = max(0.5, d_sec * 0.95)
        lo_frac, hi_frac = 0.02, 0.90
        if n == 1:
            t = max(0.25, d_sec * 0.12)
            return [min(t, cap)]
        out = []
        for k in range(n):
            frac = lo_frac + (hi_frac - lo_frac) * (k / (n - 1))
            t = max(0.25, d_sec * frac)
            out.append(min(t, cap))
        return out
    fixed = [
        0.25,
        0.5,
        0.85,
        1.2,
        1.8,
        2.5,
        3.5,
        5.0,
        6.5,
        8.0,
        10.0,
        12.0,
        15.0,
        20.0,
        28.0,
        38.0,
        50.0,
        65.0,
    ]
    return fixed[:n]


def _extract_easyocr_probe_frames(video_path, out_dir, n_frames):
    """Save full-frame PNGs for crop-ratio scoring."""
    import cv2

    out_dir.mkdir(parents=True, exist_ok=True)
    duration_ms = get_media_duration_ms(video_path)
    times = _easyocr_probe_timestamps_sec(duration_ms, n_frames)
    paths = []
    for i, t in enumerate(times):
        p = out_dir / f"probe_{i:02d}.png"
        run_command(
            [
                FFMPEG_BIN,
                "-y",
                "-ss",
                f"{t:.3f}",
                "-i",
                str(video_path),
                "-vframes",
                "1",
                "-q:v",
                "2",
                str(p),
            ],
            f"EasyOCR crop probe frame {i} @ {t:.2f}s",
        )
        if p.exists() and p.stat().st_size > 0:
            img = cv2.imread(str(p))
            if img is not None and img.size > 0:
                paths.append(p)
            else:
                try:
                    p.unlink(missing_ok=True)
                except TypeError:
                    if p.exists():
                        p.unlink()
    return paths


def _preprocess_easyocr_strip_like_pipeline(bgr_strip):
    """Xấp xỉ cùng eq grayscale (gamma → contrast → brightness) như _easyocr_crop_ffmpeg_vf."""
    import cv2
    import numpy as np

    gray = cv2.cvtColor(bgr_strip, cv2.COLOR_BGR2GRAY)
    x = gray.astype(np.float32) / 255.0
    g = max(float(EASYOCR_GRAY_GAMMA), 0.01)
    x = np.power(np.clip(x, 0, 1), 1.0 / g) * 255.0
    c = float(EASYOCR_GRAY_CONTRAST)
    b = float(EASYOCR_GRAY_BRIGHTNESS)
    x = (x - 128.0) * c + 128.0 + b * 255.0
    return np.clip(x, 0, 255).astype(np.uint8)





def _rebuild_easyocr_skip_regexes():
    global _EASYOCR_SKIP_COMPILED
    patterns = []
    if EASYOCR_TEXT_SKIP_DEFAULTS_ON:
        patterns.extend(EASYOCR_BUILTIN_SKIP_REGEXES)
    raw = (EASYOCR_TEXT_SKIP_REGEXES_JSON or "").strip()
    if raw and raw != "[]":
        try:
            extra = json.loads(raw)
        except json.JSONDecodeError as e:
            log(f"Step1 OCR: easyocr-text-skip-regexes-json invalid JSON: {e}")
            extra = []
        if isinstance(extra, list):
            for item in extra:
                s = str(item).strip()
                if s:
                    patterns.append(s)
    compiled = []
    for p in patterns:
        try:
            compiled.append(re.compile(p))
        except re.error as e:
            log(f"Step1 OCR: skip-regex compile failed for {p!r}: {e}")
    _EASYOCR_SKIP_COMPILED = compiled


def _easyocr_should_skip_merged_text(text):
    """True nếu block (đã gộp) fullmatch một trong các regex skip."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return True
    for cre in _EASYOCR_SKIP_COMPILED:
        try:
            if cre.fullmatch(t):
                return True
        except re.error:
            continue
    return False


_rebuild_easyocr_skip_regexes()




def _easyocr_tune_timestamp_sec(video_path):
    """Thời điểm lấy 1 frame mẫu (detect crop band)."""
    try:
        duration_ms = int(get_media_duration_ms(video_path) or 0)
    except Exception:
        duration_ms = 0
    t_sec = 1.0
    if duration_ms > 0:
        d = duration_ms / 1000.0
        t_sec = min(max(d * 0.12, 0.25), max(d - 0.1, 0.25))
        t_sec = min(t_sec, 120.0)
    return t_sec




def _detect_easyocr_crop_band(video_path, reader, ocr_dir):
    """
    Detect subtitle band (lo, hi) bằng cách chạy OCR trên phần đáy full-frame,
    lấy bbox chữ thực để xác định lo/hi chính xác, sau đó cap theo strip_max.

    lo/hi tính từ đáy frame (0 = sát đáy, 1 = đỉnh frame).
    Fallback: hi = EASYOCR_SUBTITLE_CROP_BAND_HI, lo = hi - strip_max.
    """
    import cv2

    hi_max = float(EASYOCR_SUBTITLE_CROP_BAND_HI)
    strip_max = float(EASYOCR_MAX_STRIP_HEIGHT_RATIO or 0.05)
    fallback_hi = hi_max
    fallback_lo = max(0.0, fallback_hi - strip_max)

    SCAN_HI = 0.4    # quét 40% đáy frame để bắt hết phụ đề
    PAD = 0.015      # padding quanh bbox (1.5% chiều cao frame) — đủ cho descender/ascender
    # Box có hi quá cao (xa đáy) → khả năng watermark góc trên, không phải phụ đề đáy.
    HI_OUTLIER_MIN = hi_max + 0.05
    lo_floor = 0.0   # giới hạn dưới của lo (sát đáy frame)

    probe_dir = ocr_dir / "probe_src"
    shutil.rmtree(probe_dir, ignore_errors=True)
    frame_paths = _extract_easyocr_probe_frames(video_path, probe_dir, EASYOCR_CROP_PROBE_FRAMES)
    if not frame_paths:
        log(f"Step1 OCR: crop detect — không lấy được frame mẫu, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    all_lo: list[float] = []
    all_hi: list[float] = []
    for fp in frame_paths:
        img = cv2.imread(str(fp))
        try:
            fp.unlink()
        except OSError:
            pass
        if img is None:
            continue
        ih, iw = img.shape[:2]
        if ih < 40 or iw < 40:
            continue
        scan_top = int(ih * (1.0 - SCAN_HI))
        scan_strip = img[scan_top:, :]
        gray = _preprocess_easyocr_strip_like_pipeline(scan_strip)
        try:
            results = reader.readtext(gray, detail=1)
        except Exception:
            continue
        frame_boxes = []
        for item in results:
            if not item or len(item) < 3:
                continue
            box, text, conf = item[0], item[1], item[2]
            conf_f = float(conf)
            text_s = str(text or "").strip()
            if conf_f < float(EASYOCR_MIN_CONFIDENCE):
                log(
                    f"Step1 OCR: crop detect [{fp.name}] skip conf={conf_f:.2f} "
                    f'text="{text_s[:30]}"'
                )
                continue
            if not text_s:
                continue
            if _easyocr_should_skip_merged_text(text_s):
                log(
                    f"Step1 OCR: crop detect [{fp.name}] skip regex watermark "
                    f'conf={conf_f:.2f} "{text_s[:30]}"'
                )
                continue
            ys = [float(pt[1]) for pt in box]
            y_top_in_scan = min(ys)
            y_bot_in_scan = max(ys)
            y_top_frame = scan_top + y_top_in_scan
            y_bot_frame = scan_top + y_bot_in_scan
            hi_cand = (ih - y_top_frame) / ih
            lo_cand = max(0.0, (ih - y_bot_frame) / ih)
            if hi_cand > HI_OUTLIER_MIN:
                log(
                    f"Step1 OCR: crop detect [{fp.name}] skip watermark top "
                    f"hi={hi_cand:.3f} > max={HI_OUTLIER_MIN:.3f} "
                    f'conf={conf_f:.2f} "{text_s[:20]}"'
                )
                continue
            all_hi.append(hi_cand)
            all_lo.append(lo_cand)
            frame_boxes.append((conf_f, text_s, lo_cand, hi_cand))
        if frame_boxes:
            parts = " | ".join(
                f'conf={c:.2f} lo={l:.3f} hi={h:.3f} "{t[:20]}"'
                for c, t, l, h in frame_boxes
            )
            log(f"Step1 OCR: crop detect [{fp.name}] {parts}")

    shutil.rmtree(probe_dir, ignore_errors=True)

    if not all_hi:
        log(f"Step1 OCR: crop detect — không tìm thấy text, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    n = len(all_hi)
    all_hi_s = sorted(all_hi)
    all_lo_s = sorted(all_lo)
    # Dùng p95/p5 thay vì p90/p10 để bao nhiều boxes hơn, tránh cắt phụ đề thật ngoài cùng
    det_hi = all_hi_s[min(n - 1, int(n * 0.95))] + PAD
    det_lo = max(lo_floor, all_lo_s[max(0, int(n * 0.05))] - PAD)
    det_hi = min(1.0, det_hi)
    log(
        f"Step1 OCR: crop detect dist "
        f"hi=[{all_hi_s[0]:.3f}…{all_hi_s[-1]:.3f}] p95={all_hi_s[min(n-1,int(n*0.95))]:.3f} "
        f"lo=[{all_lo_s[0]:.3f}…{all_lo_s[-1]:.3f}] p5={all_lo_s[max(0,int(n*0.05))]:.3f} "
        f"n={n}"
    )

    if strip_max > 0 and det_hi > det_lo + strip_max + 1e-9:
        det_hi = det_lo + strip_max

    if det_hi <= det_lo + 1e-9:
        log(f"Step1 OCR: crop detect — dải không hợp lệ sau tính toán, fallback lo={fallback_lo:.3f} hi={fallback_hi:.3f}")
        return fallback_lo, fallback_hi

    log(
        f"Step1 OCR: crop detect lo={det_lo:.3f} hi={det_hi:.3f} "
        f"strip_pct={(det_hi - det_lo) * 100:.1f} n_boxes={n}"
    )
    return det_lo, det_hi


def _step1_ocr_with_easyocr(video_path):
    """Step1: extract subtitles via EasyOCR on the cropped subtitle region."""
    log("Step1: OCR (EasyOCR)…")
    import concurrent.futures
    from difflib import SequenceMatcher

    try:
        import easyocr
    except ImportError:
        raise RuntimeError(
            "easyocr is not installed. Run: pip install easyocr opencv-python-headless"
        )

    ocr_dir = LOG_DIR / "step1_ocr"
    frames_dir = ocr_dir / "frames"
    shutil.rmtree(ocr_dir, ignore_errors=True)
    ocr_dir.mkdir(parents=True, exist_ok=True)

    reader = easyocr.Reader(EASYOCR_LANG, gpu=EASYOCR_GPU)
    log(
        "Step1 OCR: gray eq (crop) "
        f"contrast={EASYOCR_GRAY_CONTRAST:.3f} "
        f"brightness={EASYOCR_GRAY_BRIGHTNESS:.3f} "
        f"gamma={EASYOCR_GRAY_GAMMA:.3f}"
    )
    band_lo, band_hi = _detect_easyocr_crop_band(video_path, reader, ocr_dir)
    if band_hi <= band_lo + 1e-9:
        raise RuntimeError(
            f"Step1 OCR: invalid crop band lo={band_lo} hi={band_hi} (need hi > lo)."
        )

    log(
        "Step1 OCR: crop apply "
        f"lo={band_lo:.3f} hi={band_hi:.3f} strip_pct={(band_hi - band_lo) * 100:.1f}"
    )

    frames_dir.mkdir(parents=True, exist_ok=True)

    # --- 1. Crop subtitle region + preprocess (grayscale + contrast boost) ---
    crop_video = ocr_dir / "cropped.mp4"
    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-vf",
            _easyocr_crop_ffmpeg_vf(band_lo, band_hi),
            "-an",
            "-c:v",
            "libx264",
            "-crf",
            "23",
            "-preset",
            "ultrafast",
            str(crop_video),
        ],
        "Crop subtitle region",
    )

    # --- 2. Extract frames ---
    run_command(
        [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(crop_video),
            "-vf",
            f"fps={EASYOCR_FPS}",
            str(frames_dir / "frame_%05d.png"),
        ],
        "Extract frames for OCR",
    )

    frame_files = sorted(frames_dir.glob("frame_*.png"))
    if not frame_files:
        raise RuntimeError("Step1 OCR: no frames extracted.")

    # --- 3. OCR with EasyOCR (parallel ThreadPoolExecutor) ---
    frame_interval_sec = 1.0 / EASYOCR_FPS

    def ocr_frame(idx_path):
        idx, fpath = idx_path
        timestamp_sec = idx * frame_interval_sec
        try:
            results = reader.readtext(str(fpath), detail=1)
            texts = [
                t.strip()
                for _bbox, t, conf in results
                if conf >= EASYOCR_MIN_CONFIDENCE and t.strip()
            ]
            return timestamp_sec, " ".join(texts)
        except Exception:
            return timestamp_sec, ""

    raw_results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=EASYOCR_WORKERS) as pool:
        indexed = list(enumerate(frame_files))
        futures = {pool.submit(ocr_frame, item): item[0] for item in indexed}
        for fut in progressbar(
            concurrent.futures.as_completed(futures),
            total=len(futures),
            desc="EasyOCR frames",
        ):
            ts, text = fut.result()
            if text:
                raw_results.append((ts, text))

    raw_results.sort(key=lambda x: x[0])

    # --- 4. Text cleaning ---
    _re_keep = re.compile(r"[\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+")

    def clean_text(t):
        parts = _re_keep.findall(t)
        return re.sub(r"\s+", " ", " ".join(parts)).strip()

    def fuzzy_sim(a, b):
        return SequenceMatcher(None, a, b).ratio() * 100

    cleaned = [(ts, clean_text(text)) for ts, text in raw_results]
    cleaned = [(ts, text) for ts, text in cleaned if text]

    if not cleaned:
        raise RuntimeError("Step1 OCR: no text survived cleaning.")

    # --- 5. Group by time + fuzzy dedup ---
    # First pass: extend same-subtitle groups frame by frame
    groups = []  # each entry: [start_sec, end_sec, text]
    for ts, text in cleaned:
        if groups and fuzzy_sim(groups[-1][2], text) >= EASYOCR_FUZZY_THRESHOLD:
            groups[-1][1] = ts + frame_interval_sec
        else:
            groups.append([ts, ts + frame_interval_sec, text])

    # Second pass: merge groups separated by a small silent gap
    merged = []
    for block in groups:
        if (
            merged
            and fuzzy_sim(merged[-1][2], block[2]) >= EASYOCR_FUZZY_THRESHOLD
            and (block[0] - merged[-1][1]) * 1000 <= EASYOCR_MERGE_GAP_MS
        ):
            merged[-1][1] = block[1]
        else:
            merged.append(list(block))

    if not merged:
        raise RuntimeError("Step1 OCR: no subtitle groups after dedup.")

    kept = []
    skipped = 0
    for start, end, text in merged:
        if _easyocr_should_skip_merged_text(text):
            skipped += 1
            continue
        kept.append((start, end, text))
    if skipped:
        log(f"Step1 OCR: skipped {skipped} block(s) (regex full-match after clean)")
    if not kept:
        raise RuntimeError(
            "Step1 OCR: all subtitle blocks were removed by regex skip filter."
        )

    # --- 6. Export SRT ---
    srt_path = get_zh_srt_path()
    with open(srt_path, "w", encoding="utf8") as f:
        for i, (start, end, text) in enumerate(kept, 1):
            if (end - start) * 1000 < EASYOCR_MIN_DURATION_MS:
                end = start + EASYOCR_MIN_DURATION_MS / 1000.0
            f.write(f"{i}\n")
            f.write(f"{fmt_time(start)} --> {fmt_time(end)}\n")
            f.write(f"{text}\n\n")
    log(f"Step1: OCR done — {len(kept)} blocks (after skip filter).")
    return srt_path


def step1_transcribe(video_path):
    source_mode = str(STEP1_SUBTITLE_SOURCE or "whisper").strip().lower()
    if source_mode == "embedded":
        return _step1_extract_embedded_subtitle(video_path)
    if source_mode == "whisper":
        return _step1_transcribe_with_whisper(video_path)
    if source_mode == "easyocr":
        return _step1_ocr_with_easyocr(video_path)
    raise RuntimeError(
        f"Unsupported Step1 source: {STEP1_SUBTITLE_SOURCE}. "
        "Use --step1-subtitle-source whisper|embedded|easyocr."
    )


# ==============================
# STEP 2
# Gemini translate zh -> vi (batched)
# ==============================


def translate_batch_with_gemini(batch, batch_start_index):
    global ACTIVE_GEMINI_KEY_INDEX
    payload = [{"id": i, "text": b["text"]} for i, b in enumerate(batch)]

    # Base prompt
    prompt_parts = [
        "Translate Chinese subtitles into Vietnamese.\n"
        "Write very concise, subtitle-friendly Vietnamese.\n"
        "Keep original meaning and emotional tone, but simplify phrasing.\n"
        "Preserve historical tone, titles, names, and relationships.\n"
    ]

    # Add custom context if provided, otherwise use default
    if TRANSLATION_CONTEXT and TRANSLATION_CONTEXT.strip():
        prompt_parts.append(f"{TRANSLATION_CONTEXT.strip()}\n")
    else:
        # Default context for Chinese historical/wuxia/xianxia
        prompt_parts.extend(
            [
                "Use Sino-Vietnamese (Han-Viet) pronouns/family terms when appropriate.\n"
                "Context: Chinese historical / wuxia / xianxia animation.\n"
                "Examples: Người Tôm => Hà Nhân, Thượng vị => hoàng thượng, cha => phụ thân, mẹ => mẫu thân, anh trai => huynh trưởng, em trai => đệ đệ.\n"
            ]
        )

    prompt_parts.extend(
        [
            "Avoid verbose or literary wording unless required by context.\n"
            "Do NOT explain anything.\n"
            'Return ONLY JSON array, exact schema: [{"id":0,"vi":"..."}]\n'
            f"Input JSON:\n{json.dumps(payload, ensure_ascii=False)}"
        ]
    )

    prompt = "".join(prompt_parts)

    debug_dir = LOG_DIR / "gemini_debug"
    debug_dir.mkdir(parents=True, exist_ok=True)
    batch_name = f"batch_{batch_start_index:06d}"
    request_path = debug_dir / f"{batch_name}_request.txt"
    response_path = debug_dir / f"{batch_name}_response.txt"
    request_content = (
        f"model: {GEMINI_MODEL_NAME}\n"
        f"batch_start_index: {batch_start_index}\n"
        f"batch_size: {len(batch)}\n\n"
        f"prompt:\n{prompt}\n"
    )
    write_text(request_path, request_content)

    attempt_no = 0

    def _is_token_limit_error(exc):
        text = str(exc or "").lower()
        return any(
            key in text
            for key in (
                "token",
                "quota",
                "resource_exhausted",
                "rate limit",
                "too many requests",
                "429",
            )
        )

    def _is_high_demand_error(exc):
        text = str(exc or "").lower()
        return any(
            key in text
            for key in (
                "high demand",
                "overloaded",
                "service unavailable",
                "unavailable",
                "temporarily unavailable",
                "503",
            )
        )

    def _call():
        global ACTIVE_GEMINI_KEY_INDEX
        nonlocal attempt_no
        total_key_count = len(GEMINI_CLIENTS)
        if total_key_count == 0:
            raise RuntimeError("No Gemini API keys available.")
        key_count = total_key_count if STEP2_MULTI_KEYS_ENABLED else 1
        start_idx = ACTIVE_GEMINI_KEY_INDEX % total_key_count
        last_error = None

        for offset in range(key_count):
            key_idx = (start_idx + offset) % total_key_count
            key_masked = mask_secret(GEMINI_API_KEYS[key_idx])
            attempt_no += 1
            try:
                response = GEMINI_CLIENTS[key_idx].models.generate_content(
                    model=GEMINI_MODEL_NAME,
                    contents=prompt,
                )
                raw_text = response.text or ""
                append_text(
                    response_path,
                    (
                        f"===== attempt {attempt_no} | key {key_idx + 1}/{total_key_count} "
                        f"({key_masked}) | {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"
                        f"{raw_text}\n\n"
                    ),
                )
                data = extract_json_array(raw_text)
                mapped = {}
                for item in data:
                    idx = int(item["id"])
                    mapped[idx] = str(item["vi"]).strip()
                ACTIVE_GEMINI_KEY_INDEX = key_idx
                return mapped
            except Exception as e:
                last_error = e
                append_text(
                    response_path,
                    (
                        f"===== attempt {attempt_no} | key {key_idx + 1}/{total_key_count} "
                        f"({key_masked}) | {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"
                        f"ERROR: {e}\n\n"
                    ),
                )
                if _is_high_demand_error(e):
                    # User requirement: high demand/server overload must stop immediately.
                    raise RuntimeError(
                        f"Gemini server high demand/unavailable on key {key_idx + 1}/{total_key_count}; "
                        f"stop without key rotation. Error: {e}"
                    ) from e
                if offset < key_count - 1:
                    if not _is_token_limit_error(e):
                        # Only rotate keys for token/quota/rate-limit class errors.
                        raise RuntimeError(
                            f"Gemini translation failed with non-rotatable error on key "
                            f"{key_idx + 1}/{total_key_count}: {e}"
                        ) from e
                    next_key_idx = (key_idx + 1) % total_key_count
                    log(
                        f"Step2: Gemini key {key_idx + 1}/{total_key_count} → "
                        f"{next_key_idx + 1}/{total_key_count}."
                    )

        if STEP2_MULTI_KEYS_ENABLED:
            raise RuntimeError(
                f"Gemini translation failed on all {total_key_count} keys. Last error: {last_error}"
            ) from last_error
        raise RuntimeError(
            f"Gemini translation failed on active key only (multi-keys off). Last error: {last_error}"
        ) from last_error

    return retry_call(
        _call, "Gemini translation", max_retry=GEMINI_RETRY_MAX, db_step=2
    )


def step2_translate_srt(srt_path):
    key_mode = "multi-keys on" if STEP2_MULTI_KEYS_ENABLED else "multi-keys off"
    log(f"Step2: Gemini ({key_mode})…")
    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())

    translated_blocks = []
    for i in progressbar(range(0, len(blocks), TRANSLATE_BATCH_SIZE), desc="Translate"):
        batch = blocks[i : i + TRANSLATE_BATCH_SIZE]
        mapping = translate_batch_with_gemini(batch, i)
        for local_idx, b in enumerate(batch):
            translated_text = mapping.get(local_idx, b["text"])
            translated_blocks.append(
                {"index": b["index"], "time": b["time"], "text": translated_text}
            )

    out_path = get_vi_srt_path()
    write_srt(translated_blocks, out_path)
    return out_path


# ==============================
# STEP 3
# TTS generate voice directly from SRT (chunked)
# ==============================


def step3_generate_voice_from_srt(srt_path, target_duration_ms=None):
    log("Step3: edge-tts (timeline SRT)…")
    import edge_tts

    async def _generate_edge_tts_mp3(text, out_path, rate):
        communicate = edge_tts.Communicate(
            text=text,
            voice=EDGE_TTS_VOICE,
            rate=rate,
            volume=EDGE_TTS_VOLUME,
            pitch=EDGE_TTS_PITCH,
        )
        out = str(out_path)
        timeout_sec = float(STEP3_TTS_API_TIMEOUT_SEC)
        if timeout_sec <= 0:
            await communicate.save(out)
        else:
            try:
                await asyncio.wait_for(communicate.save(out), timeout=timeout_sec)
            except asyncio.TimeoutError as exc:
                raise TimeoutError(
                    f"edge-tts request timed out after {timeout_sec:.1f}s"
                ) from exc

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

        raw_audio_path = chunk_dir / f"raw_{i:04d}.mp3"
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
            asyncio.run(_generate_edge_tts_mp3(subtitle_text, raw_audio_path, rate))

        tts_rate, _ = resolve_dynamic_tts_rate(subtitle_text, subtitle_duration_ms)
        subtitle_idx = block.get("index", i + 1)
        tts_retry_label = f"Step3 TTS seg {subtitle_idx} (timeline {i})"
        ok_tts = step3_tts_retry(
            lambda: run_tts(tts_rate),
            tts_retry_label,
            max_retry=TTS_RETRY_MAX,
            db_step=3,
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
        if STEP3_AUTO_RATE_ENABLED and raw_segment_ms and subtitle_duration_ms > 220:
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
                            db_step=3,
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
        "Concatenate edge-tts timeline segments",
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
    run_command(
        [
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
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-c:a",
            "aac",
            "-shortest",
            *ffmpeg_output_metadata_args(out),
            str(out),
        ],
        "Merge narration audio (pre-merge speed)",
    )
    return out


def build_step7_speed_command(video_path, part_path, speed, use_gpu, has_audio):
    """Step7: setpts + atempo; video encode NVENC (GPU) hoặc libx264 (CPU), giống Step6."""
    meta = ffmpeg_output_metadata_args(part_path)
    if use_gpu:
        v_enc = ["-c:v", "h264_nvenc", "-preset", "p4", "-cq", "23"]
    else:
        v_enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "23"]
    if has_audio:
        atempo_filter = build_atempo_filter(speed)
        return [
            FFMPEG_BIN,
            "-y",
            "-i",
            str(video_path),
            "-filter_complex",
            f"[0:v]setpts=PTS/{speed:.6f}[v];[0:a]{atempo_filter}[a]",
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
    return [
        FFMPEG_BIN,
        "-y",
        "-i",
        str(video_path),
        "-filter_complex",
        f"[0:v]setpts=PTS/{speed:.6f}[v]",
        "-map",
        "[v]",
        *v_enc,
        "-an",
        *meta,
        "-f",
        "mp4",
        str(part_path),
    ]


def step7_apply_speed(video_path):
    if abs(float(SPEED_VIDEO) - 1.0) < 1e-6:
        return video_path

    speed = float(SPEED_VIDEO)
    if speed <= 0:
        raise ValueError(f"speed-video must be > 0, got {speed}")

    final_out = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    part = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4.part"
    has_audio = media_has_audio_stream(video_path)
    gpu_cmd = build_step7_speed_command(
        video_path, part, speed, use_gpu=True, has_audio=has_audio
    )
    try:
        label = f"Apply speed-video x{speed:.3f}" + (
            "" if has_audio else " (video-only)"
        )
        run_command(gpu_cmd, f"{label} (GPU)")
    except Exception as e:
        log(f"Step7: GPU encode failed → CPU: {e}")
        cpu_cmd = build_step7_speed_command(
            video_path, part, speed, use_gpu=False, has_audio=has_audio
        )
        label = f"Apply speed-video x{speed:.3f}" + (
            "" if has_audio else " (video-only)"
        )
        run_command(cpu_cmd, f"{label} (CPU)")
    try:
        os.replace(part, final_out)
    except OSError:
        if part.is_file():
            part.unlink(missing_ok=True)
        raise
    return final_out


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
    if STEP6_VISUAL_TRANSFORM_ENABLED and float(STEP6_ZOOM_PERCENT) > 0.01:
        zf = 1.0 + float(STEP6_ZOOM_PERCENT) / 100.0
        log(
            "Step6: zoom active — output W/H can differ slightly from input "
            f"(integer scale then crop by zf={zf:.4f}; set --step6-zoom-percent 0 to keep size)."
        )
    subtitle_filter = build_subtitle_filter(ass_path)
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
        "--step6-eq-saturation", type=float, default=STEP6_EQ_SATURATION
    )
    parser.add_argument("--step6-eq-contrast", type=float, default=STEP6_EQ_CONTRAST)
    parser.add_argument(
        "--step6-unsharp",
        default=STEP6_UNSHARP,
        help='ffmpeg unsharp= params, e.g. "5:5:0.8:3:3:0.0".',
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
        "--speed-video",
        type=float,
        default=SPEED_VIDEO,
        help="Step7 after subtitle render: re-encode *_vs_tm.mp4 in place (temp .part). 1.0 = skip Step7 encode.",
    )
    parser.add_argument(
        "--whisper-language",
        default=WHISPER_LANGUAGE,
        help="Whisper language code. Example: zh, en, vi.",
    )
    parser.add_argument(
        "--step1-subtitle-source",
        choices=["whisper", "embedded", "easyocr"],
        default=STEP1_SUBTITLE_SOURCE,
        help=(
            "Step1 subtitle source: whisper=ASR from audio, "
            "embedded=extract subtitle stream with ffmpeg, "
            "easyocr=visual OCR on subtitle region."
        ),
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
        "--easyocr-cleanup-debug-after-step7",
        choices=["on", "off"],
        default="on" if EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 else "off",
        help=(
            "on (default): after successful Step7, delete LOG_DIR/step1_ocr and "
            "LOG_DIR/easyocr_crop_probe. off: keep those folders for inspection."
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
        default=EASYOCR_FPS,
        help="Frame extraction rate for EasyOCR (default 2).",
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
        help="EasyOCR: minimum SRT cue duration (ms) after merge (default 500). Lower = shorter cues allowed.",
    )
    parser.add_argument(
        "--easyocr-fuzzy-threshold",
        type=float,
        default=EASYOCR_FUZZY_THRESHOLD,
        help="Similarity %% threshold for fuzzy dedup/merge (default 80).",
    )
    parser.add_argument(
        "--easyocr-gpu",
        choices=["on", "off"],
        default="on" if EASYOCR_GPU else "off",
        help="Enable GPU for EasyOCR inference (default on).",
    )
    parser.add_argument(
        "--easyocr-gray-contrast",
        type=float,
        default=EASYOCR_GRAY_CONTRAST,
        help="OCR crop: grayscale eq contrast (default 2). Lower if dialogue text is too faint.",
    )
    parser.add_argument(
        "--easyocr-gray-brightness",
        type=float,
        default=EASYOCR_GRAY_BRIGHTNESS,
        help=(
            "OCR crop: grayscale eq brightness (ffmpeg, about -1..1). "
            "Negative (e.g. -0.08) darkens the strip to reduce bright logo/watermark pickup."
        ),
    )
    parser.add_argument(
        "--easyocr-gray-gamma",
        type=float,
        default=EASYOCR_GRAY_GAMMA,
        help="OCR crop: grayscale eq gamma; >1 darkens midtones slightly (can soften flat white marks).",
    )
    parser.add_argument(
        "--mode",
        choices=["basic", "advance"],
        default="basic",
        help="Step1 VAD/Whisper profile: basic (nhẹ, giọng yếu/ASMR) or advance (stricter thresholds).",
    )
    parser.add_argument(
        "--step1-vad",
        choices=["on", "off"],
        default="on" if STEP1_VAD_FILTER else "off",
        help="Enable/disable VAD filter in Step1 to reduce music/noise transcription.",
    )
    parser.add_argument(
        "--step1-vad-threshold",
        type=float,
        default=None,
        help="Override Silero VAD threshold (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-min-silence-ms",
        type=int,
        default=None,
        help="Override min silence ms between VAD segments (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-min-speech-ms",
        type=int,
        default=None,
        help="Override min speech segment ms (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-speech-pad-ms",
        type=int,
        default=None,
        help="Override speech pad ms (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-no-speech-threshold",
        type=float,
        default=None,
        help="Whisper no-speech threshold; higher skips non-speech more (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-logprob-threshold",
        type=float,
        default=None,
        help="Whisper avg logprob threshold (default from --mode if omitted).",
    )
    parser.add_argument(
        "--step1-condition-on-previous-text",
        choices=["on", "off"],
        default=None,
        help="Context from previous text; default from --mode if omitted.",
    )
    parser.add_argument("--edge-tts-voice", default=EDGE_TTS_VOICE)
    parser.add_argument("--edge-tts-rate", default=EDGE_TTS_RATE)
    parser.add_argument("--edge-tts-volume", default=EDGE_TTS_VOLUME)
    parser.add_argument("--edge-tts-pitch", default=EDGE_TTS_PITCH)
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
        help="Per-request timeout for edge-tts (save). 0 disables timeout.",
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
        help="on=đọc/ghi checkpoint trong logs/tts_chunks; chỉ gọi edge-tts cho segment chưa trong list + chưa có part_XXXX.wav (tiết kiệm rate).",
    )
    parser.add_argument(
        "--translation-context",
        default=TRANSLATION_CONTEXT,
        help="Custom context/instructions for Gemini translation. Overrides default Han-Viet prompt.",
    )
    parser.add_argument(
        "--step2-multi-keys",
        choices=["on", "off"],
        default="on" if STEP2_MULTI_KEYS_ENABLED else "off",
        help="Step2 Gemini: on=rotate through all keys on error; off=use active key only.",
    )
    parser.add_argument(
        "--processbar-log",
        choices=["on", "off"],
        default="on" if PROCESSBAR_LOG_ENABLED else "off",
        help="Show tqdm process bars in output logs.",
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
    global SPEED_VIDEO
    global STEP4_MERGE_SPEED
    global EDGE_TTS_VOICE
    global STEP3_AUTO_RATE_ENABLED
    global STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC
    global STEP3_AUTO_RATE_BONUS_PERCENT
    global STEP3_TTS_BORROW_GAP
    global STEP3_TTS_API_TIMEOUT_SEC
    global STEP3_TTS_MAX_RETRY_ACTION
    global STEP3_VOICE_RESUME
    global TRANSLATION_CONTEXT
    global STEP2_MULTI_KEYS_ENABLED
    global PROCESSBAR_LOG_ENABLED
    WHISPER_LANGUAGE = str(args.whisper_language).strip() or None
    STEP1_SUBTITLE_SOURCE = (
        str(args.step1_subtitle_source or STEP1_SUBTITLE_SOURCE).strip().lower()
    )
    global EDGE_TTS_RATE
    global EDGE_TTS_VOLUME
    global EDGE_TTS_PITCH
    global STEP1_VAD_FILTER
    global STEP1_VAD_THRESHOLD
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
    global EASYOCR_GRAY_CONTRAST
    global EASYOCR_GRAY_BRIGHTNESS
    global EASYOCR_GRAY_GAMMA
    global EASYOCR_CLEANUP_DEBUG_AFTER_STEP7
    global EASYOCR_MAX_STRIP_HEIGHT_RATIO
    global EASYOCR_TEXT_SKIP_DEFAULTS_ON
    global EASYOCR_TEXT_SKIP_REGEXES_JSON

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
    SPEED_VIDEO = args.speed_video
    STEP4_MERGE_SPEED = float(args.step4_merge_speed)

    EDGE_TTS_VOICE = args.edge_tts_voice
    EDGE_TTS_RATE = resolve_base_tts_rate(args.edge_tts_rate)
    EDGE_TTS_VOLUME = args.edge_tts_volume
    EDGE_TTS_PITCH = args.edge_tts_pitch
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
    STEP2_MULTI_KEYS_ENABLED = args.step2_multi_keys == "on"
    PROCESSBAR_LOG_ENABLED = args.processbar_log == "on"

    prof = STEP1_PROFILES[args.mode]
    STEP1_VAD_FILTER = args.step1_vad == "on"
    STEP1_VAD_THRESHOLD = (
        args.step1_vad_threshold
        if args.step1_vad_threshold is not None
        else prof["vad_threshold"]
    )
    STEP1_MIN_SILENCE_MS = (
        args.step1_min_silence_ms
        if args.step1_min_silence_ms is not None
        else prof["min_silence_ms"]
    )
    STEP1_MIN_SPEECH_MS = (
        args.step1_min_speech_ms
        if args.step1_min_speech_ms is not None
        else prof["min_speech_ms"]
    )
    STEP1_SPEECH_PAD_MS = (
        args.step1_speech_pad_ms
        if args.step1_speech_pad_ms is not None
        else prof["speech_pad_ms"]
    )
    STEP1_NO_SPEECH_THRESHOLD = (
        args.step1_no_speech_threshold
        if args.step1_no_speech_threshold is not None
        else prof["no_speech_threshold"]
    )
    STEP1_LOGPROB_THRESHOLD = (
        args.step1_logprob_threshold
        if args.step1_logprob_threshold is not None
        else prof["logprob_threshold"]
    )
    if args.step1_condition_on_previous_text is not None:
        STEP1_CONDITION_ON_PREVIOUS_TEXT = args.step1_condition_on_previous_text == "on"
    else:
        STEP1_CONDITION_ON_PREVIOUS_TEXT = prof["condition_on_previous_text"]

    if args.easyocr_lang:
        EASYOCR_LANG = [s.strip() for s in args.easyocr_lang.split(",") if s.strip()]
    EASYOCR_SUBTITLE_CROP_BAND_HI = float(args.easyocr_crop_band_hi)
    EASYOCR_CLEANUP_DEBUG_AFTER_STEP7 = (
        args.easyocr_cleanup_debug_after_step7 == "on"
    )
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
    _rebuild_easyocr_skip_regexes()
    EASYOCR_FPS = float(args.easyocr_fps)
    EASYOCR_WORKERS = int(args.easyocr_workers)
    EASYOCR_MIN_CONFIDENCE = float(args.easyocr_min_confidence)
    EASYOCR_MIN_DURATION_MS = max(1, int(args.easyocr_min_duration_ms))
    EASYOCR_FUZZY_THRESHOLD = float(args.easyocr_fuzzy_threshold)
    EASYOCR_GPU = args.easyocr_gpu == "on"
    EASYOCR_GRAY_CONTRAST = max(0.01, float(getattr(args, "easyocr_gray_contrast", EASYOCR_GRAY_CONTRAST)))
    EASYOCR_GRAY_BRIGHTNESS = float(
        getattr(args, "easyocr_gray_brightness", EASYOCR_GRAY_BRIGHTNESS)
    )
    EASYOCR_GRAY_GAMMA = max(
        0.01, float(getattr(args, "easyocr_gray_gamma", EASYOCR_GRAY_GAMMA))
    )


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
    """Sau Step7 xong: xóa thư mục tạm EasyOCR (step1_ocr + easyocr_crop_probe dưới LOG_DIR)."""
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


def _run_step6_and_finalize(ass, tm_video, video_path, skip_voice_step):
    require_ready(ass, "Step6 input sub.ass")
    if skip_voice_step:
        video_for_render = video_path
    else:
        video_for_render = require_ready(tm_video, "Step6 input merged video (_tm.mp4)")
    # Re-apply subtitle style even when ASS is reused from cache.
    update_ass_default_style(ass)
    final = step6_render(video_for_render, ass)
    final = step7_apply_speed(final)
    if not file_ready(final):
        raise RuntimeError("Final video render failed.")
    _cleanup_easyocr_artifacts_after_step7()
    if not skip_voice_step and tm_video.is_file():
        tm_video.unlink()
    if ass.is_file():
        ass.unlink()
    log(f"DONE: {final}")
    return final


# ==============================
# MAIN PIPELINE
# ==============================


def run_pipeline(video, step_arg=None):
    global WORK_NAME, WORK_DIR, VIDEO_DIR, SUBTITLE_DIR, LOG_DIR, LOG_PATH
    video_path = Path(video).resolve()
    if not file_ready(video_path):
        raise FileNotFoundError(f"Input video not found: {video_path}")

    # Group all generated artifacts by input filename.
    WORK_NAME = video_path.stem
    WORK_DIR = WORK_ROOT / WORK_NAME
    VIDEO_DIR = WORK_DIR / "videos"
    SUBTITLE_DIR = WORK_DIR / "subtitles"
    LOG_DIR = WORK_DIR / "logs"
    LOG_PATH = LOG_DIR / "pipeline.log"
    VIDEO_DIR.mkdir(parents=True, exist_ok=True)
    SUBTITLE_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    preflight_checks()
    video_duration_ms = get_media_duration_ms(video_path)
    start_step, end_step = parse_step_range(step_arg)
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
        emit_db_status(step_no, "running", f"{step_name} started")
        try:
            result = fn()
            emit_db_status(step_no, "completed", f"{step_name} completed")
            return result
        except Exception as exc:
            emit_db_status(step_no, "failed", f"{step_name} failed: {exc}")
            raise RuntimeError(
                f"[STEP_{step_no}_FAILED] {step_name} failed: {exc}"
            ) from exc

    if step_enabled(1):
        zh_srt = run_step(
            1,
            "Step1",
            lambda: get_or_run(zh_srt, "Step1", step1_transcribe, video_path),
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
                    get_or_run(tm_video, "Step4", step4_merge_audio, video_path, voice),
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
                video_path=video_path,
                skip_voice_step=SKIP_VOICE_STEP,
            ),
        )
        last_output = final
    else:
        log("Stopped before Step6 by --step option.")

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
