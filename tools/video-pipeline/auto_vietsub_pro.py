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
from pathlib import Path

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
GEMINI_MODEL_NAME = "gemini-2.5-flash"
EDGE_TTS_VOICE = "vi-VN-HoaiMyNeural"
EDGE_TTS_RATE = "+40%"
EDGE_TTS_VOLUME = "+20%"
EDGE_TTS_PITCH = "+0Hz"
STEP3_AUTO_RATE_ENABLED = True
TRANSLATION_CONTEXT = ""  # Custom translation context for Gemini prompt
STEP3_AUTO_RATE_TRIGGER_CHARS_PER_SEC = 14.0
STEP3_AUTO_RATE_BONUS_PERCENT = 30
STEP3_RATE_MIN_PERCENT = -50
STEP3_RATE_MAX_PERCENT = 95
STEP3_TTS_REQUEST_SLEEP_MS = 300
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
TTS_RETRY_MAX = 10
FFMPEG_BIN = None
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
OUTPUT_METADATA_TITLE = "Vạn Giới Vietsub"
OUTPUT_METADATA_ARTIST = "Vạn Giới Vietsub"
OUTPUT_METADATA_COMMENT = "Vạn Giới Vietsub"

STEP1_VAD_FILTER = True # Nếu False thì sẽ không dùng 4 key phía dưới
# Mặc định CLI: --mode basic (nhẹ, giọng nhỏ/ASMR) hoặc --mode advance (khắc khe hơn). Có thể ghi đè từng tham số.
# Override: --mode, --step1-vad-threshold, --step1-min-silence-ms, --step1-min-speech-ms, --step1-speech-pad-ms,
#           --step1-no-speech-threshold, --step1-logprob-threshold, --step1-condition-on-previous-text
STEP1_VAD_THRESHOLD = 0.35 # Silero: xác suất tối thiểu để coi là speech (thấp hơn = nhạy hơn với giọng yếu).
STEP1_MIN_SILENCE_MS = 400 # im lặng tối thiểu (ms) để tách segment VAD (cao = ít tách hơn).
STEP1_MIN_SPEECH_MS = 280 # speech tối thiểu (ms); giảm để không nuốt câu ngắn/nói nhỏ.
STEP1_SPEECH_PAD_MS = 320 # lề trước/sau mỗi đoạn speech (ms); tăng giúp bắt đầu/cuối câu nhỏ.

STEP1_NO_SPEECH_THRESHOLD = 0.78 # Whisper: chỉ lọc “no speech” khi prob rất cao (cao hơn = giữ nhiều đoạn yếu hơn).
STEP1_LOGPROB_THRESHOLD = -2.0 # Whisper: avg logprob; âm hơn = chấp nhận đoạn tin cậy thấp hơn (ít cắt hơn).
STEP1_CONDITION_ON_PREVIOUS_TEXT = False # True có thể ổn định câu liền kề nhưng dễ lan lỗi sang đoạn sau.

STEP1_MAX_SUBTITLE_CHARS = 22 # số ký tự tối đa mỗi câu sau tách.
STEP1_MIN_SUBTITLE_DURATION_MS = 280 # thời gian hiển thị tối thiểu mỗi câu.
STEP1_SHORT_TEXT_MAX_CHARS = 14 # ngưỡng để coi là “câu ngắn”.
STEP1_MIN_CHARS_PER_SEC = 2.2 # nếu cps thấp hơn ngưỡng, coi là câu ngắn bị dính khoảng trống.
STEP1_TARGET_CHARS_PER_SEC = 5.5 # tốc độ mục tiêu khi siết lại timing câu ngắn (giữ đuôi, cắt đầu).

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
    repo_root = here.parents[1]  # .../KiTLabs-BE when script is at .../tools/video-pipeline/
    for env_path in (here / ".env", here.parent / ".env", repo_root / ".env", Path.cwd() / ".env"):
        if env_path.is_file():
            load_dotenv(env_path, override=False)


_load_env_files()
API_KEY = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
if API_KEY:
    GEMINI_CLIENT = genai.Client(api_key=API_KEY)
else:
    GEMINI_CLIENT = None


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


def file_ready(path):
    p = Path(path)
    return p.exists() and p.stat().st_size > 0


def retry_call(fn, label, max_retry=RETRY_MAX, base_delay=1.5):
    for attempt in range(1, max_retry + 1):
        try:
            return fn()
        except Exception as e:
            if attempt == max_retry:
                raise RuntimeError(f"{label} failed after {max_retry} attempts: {e}") from e
            delay = base_delay * (2 ** (attempt - 1))
            log(f"{label} error (attempt {attempt}/{max_retry}): {e}. Retry in {delay:.1f}s")
            time.sleep(delay)


def run_command(args, label):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        stderr = (result.stderr or "").strip()
        raise RuntimeError(f"{label} failed (code {result.returncode}): {stderr}")
    return result


def get_media_duration_ms(path):
    ffprobe_path = Path(FFMPEG_BIN).with_name("ffprobe.exe")
    if not ffprobe_path.exists():
        return None
    try:
        result = run_command(
            [
                str(ffprobe_path),
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
            Path.home() / "scoop" / "apps" / "ffmpeg" / "current" / "bin" / "ffmpeg.exe",
        ]
    )

    for candidate in candidates:
        if candidate and candidate.exists():
            return str(candidate)
    return None


def preflight_checks():
    global FFMPEG_BIN
    log("Preflight checks...")
    if GEMINI_CLIENT is None:
        raise EnvironmentError(
            "Missing Gemini API key. Set GEMINI_API_KEY or GOOGLE_API_KEY in .env or the environment."
        )
    key_source = "GEMINI_API_KEY" if os.environ.get("GEMINI_API_KEY") else "GOOGLE_API_KEY"
    log(
        f"Gemini key detected: source={key_source}, value={mask_secret(API_KEY)}, len={len(API_KEY)}"
    )
    FFMPEG_BIN = resolve_ffmpeg_binary()
    if FFMPEG_BIN is None:
        raise EnvironmentError(
            "ffmpeg not found. Add it to PATH or set FFMPEG_PATH in script config."
        )
    run_command([FFMPEG_BIN, "-version"], "ffmpeg check")
    log(f"ffmpeg resolved: {FFMPEG_BIN}")
    log("Preflight OK.")


def fmt_time(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def srt_time_to_ms(time_str):
    hms, ms = time_str.strip().split(",")
    h, m, s = hms.split(":")
    return (
        int(h) * 3600000
        + int(m) * 60000
        + int(s) * 1000
        + int(ms)
    )


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
            text = str(b["text"])
            if SUBTITLE_UPPERCASE:
                text = text.upper()
            f.write(f"{text}\n\n")


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
    base_rate = parse_percent_string(resolve_base_tts_rate(EDGE_TTS_RATE), default_value=60.0)
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
            if w and len(w) >= 3 and w[0] is not None and w[1] is not None and float(w[1]) > float(w[0])
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
                    estimated = int(round((chunk_weight / max(remaining_chars, 1)) * remaining_words))
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
                latest_end = segment_end_bound - STEP1_MIN_SUBTITLE_DURATION_MS * remaining_after
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
            chunk_end = min(end_ms - STEP1_MIN_SUBTITLE_DURATION_MS * (len(chunks) - idx - 1), cursor + duration)
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

    target_ms = int(round((text_len / max(float(STEP1_TARGET_CHARS_PER_SEC), 0.1)) * 1000))
    max_short_ms = int(round((int(STEP1_SHORT_TEXT_MAX_CHARS) / max(float(STEP1_TARGET_CHARS_PER_SEC), 0.1)) * 1000))
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


def ffmpeg_output_metadata_args():
    """Trước path đầu ra: -map_metadata -1 và các -metadata (title/artist/comment) nếu bật."""
    if not OUTPUT_METADATA_ENABLED:
        return []
    args = ["-map_metadata", "-1"]
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


def build_step6_render_command(video_path, out_path, subtitle_filter, use_gpu, logo_path=None):
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

    meta = ffmpeg_output_metadata_args()
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
# Whisper -> <work_name>.zh.srt
# ==============================

def step1_transcribe(video_path):
    log("Step1: Transcribing video...")
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

    source_duration_ms = get_media_duration_ms(step1_audio) or get_media_duration_ms(video_path)
    if source_duration_ms:
        log(f"Step1 audio duration: {source_duration_ms / 1000:.3f}s")
    min_expected_ms = int(source_duration_ms * 0.40) if source_duration_ms else None
    log(
        "Step1 config: "
        f"language={WHISPER_LANGUAGE}, vad_filter={STEP1_VAD_FILTER}, "
        f"vad_threshold={STEP1_VAD_THRESHOLD}, min_silence_ms={STEP1_MIN_SILENCE_MS}, "
        f"no_speech_threshold={STEP1_NO_SPEECH_THRESHOLD}, "
        f"condition_on_previous_text={STEP1_CONDITION_ON_PREVIOUS_TEXT}"
    )

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
        segments, _info = whisper_model.transcribe(str(step1_audio), **transcribe_kwargs)
        count = 0
        last_end_ms = 0
        prev_end_sec = 0.0
        with open(out_path, "w", encoding="utf8") as f:
            for i, segment in enumerate(tqdm(segments, desc=f"Transcribe ({device_name})")):
                seg_start = float(segment.start)
                seg_end = float(segment.end)
                words = getattr(segment, "words", None) or []
                timed_words = [
                    (float(w.start), float(w.end), str(getattr(w, "word", "") or "").strip())
                    for w in words
                    if getattr(w, "start", None) is not None and getattr(w, "end", None) is not None
                ]
                if timed_words:
                    seg_start = min(start for start, _end, _text in timed_words)
                    seg_end = max(end for _start, end, _text in timed_words)

                # Prevent local drift from producing overlaps/inversions in the middle of the video.
                if seg_start < prev_end_sec:
                    seg_start = prev_end_sec
                if seg_end <= seg_start:
                    seg_end = seg_start + 0.2

                split_chunks = split_segment_to_timed_chunks(segment.text.strip(), seg_start, seg_end, timed_words)
                if not split_chunks:
                    continue

                for chunk_start_ms, chunk_end_ms, chunk_text in split_chunks:
                    chunk_start_ms, chunk_end_ms, tightened = tighten_sparse_subtitle_timing(
                        chunk_start_ms,
                        chunk_end_ms,
                        chunk_text,
                    )
                    chunk_start_sec = max(prev_end_sec, chunk_start_ms / 1000.0)
                    chunk_end_sec = max(chunk_end_ms / 1000.0, chunk_start_sec + 0.2)
                    if tightened:
                        log(
                            "Step1 timing tightened for sparse short subtitle: "
                            f"'{chunk_text[:40]}' -> {chunk_start_sec:.3f}s..{chunk_end_sec:.3f}s"
                        )
                    prev_end_sec = chunk_end_sec
                    last_end_ms = int(chunk_end_sec * 1000)
                    count += 1
                    f.write(f"{count}\n")
                    f.write(f"{fmt_time(chunk_start_sec)} --> {fmt_time(chunk_end_sec)}\n")
                    f.write(f"{chunk_text}\n\n")

                if count % 50 == 0:
                    log(
                        f"Step1 {device_name}: {count} segments, "
                        f"last_end={last_end_ms / 1000:.2f}s"
                    )
        return count, last_end_ms

    srt_path = get_zh_srt_path()

    try:
        log("Whisper using CUDA.")
        count, last_end_ms = _transcribe_with_device("cuda", srt_path)
        if count == 0:
            raise RuntimeError("CUDA produced no segments.")
        if min_expected_ms and last_end_ms < min_expected_ms:
            log(
                f"Step1 warning: CUDA transcript too short ({last_end_ms / 1000:.2f}s), "
                "retrying on CPU..."
            )
            count, last_end_ms = _transcribe_with_device("cpu", srt_path)
    except Exception as e:
        log(f"Step1 CUDA failed, fallback CPU: {e}")
        count, last_end_ms = _transcribe_with_device("cpu", srt_path)
        if count == 0:
            raise RuntimeError("Whisper produced no segments in Step1.")
    log(f"Step1 complete: {count} segments, last_end={last_end_ms / 1000:.2f}s")
    return srt_path


# ==============================
# STEP 2
# Gemini translate zh -> vi (batched)
# ==============================

def translate_batch_with_gemini(batch, batch_start_index):
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
        prompt_parts.extend([
            "Use Sino-Vietnamese (Han-Viet) pronouns/family terms when appropriate.\n"
            "Context: Chinese historical / wuxia / xianxia animation.\n"
            "Examples: Người Tôm => Hà Nhân, Thượng vị => hoàng thượng, cha => phụ thân, mẹ => mẫu thân, anh trai => huynh trưởng, em trai => đệ đệ.\n"
        ])
    
    prompt_parts.extend([
        "Avoid verbose or literary wording unless required by context.\n"
        "Do NOT explain anything.\n"
        "Return ONLY JSON array, exact schema: [{\"id\":0,\"vi\":\"...\"}]\n"
        f"Input JSON:\n{json.dumps(payload, ensure_ascii=False)}"
    ])
    
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

    def _call():
        nonlocal attempt_no
        attempt_no += 1
        response = GEMINI_CLIENT.models.generate_content(
            model=GEMINI_MODEL_NAME,
            contents=prompt,
        )
        raw_text = response.text or ""
        append_text(
            response_path,
            (
                f"===== attempt {attempt_no} | {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n"
                f"{raw_text}\n\n"
            ),
        )
        data = extract_json_array(raw_text)
        mapped = {}
        for item in data:
            idx = int(item["id"])
            mapped[idx] = str(item["vi"]).strip()
        return mapped

    return retry_call(_call, "Gemini translation")


def step2_translate_srt(srt_path):
    log("Step2: Translating subtitles with Gemini (batched)...")
    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())

    translated_blocks = []
    for i in tqdm(range(0, len(blocks), TRANSLATE_BATCH_SIZE), desc="Translate"):
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
    log("Step3: Generating voice with edge-tts (timeline by SRT)...")
    import edge_tts

    async def _generate_edge_tts_mp3(text, out_path, rate):
        communicate = edge_tts.Communicate(
            text=text,
            voice=EDGE_TTS_VOICE,
            rate=rate,
            volume=EDGE_TTS_VOLUME,
            pitch=EDGE_TTS_PITCH,
        )
        await communicate.save(str(out_path))

    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())
    if not blocks:
        raise ValueError("Vietnamese subtitle file has no valid subtitle blocks.")

    has_text = any(b["text"].strip() for b in blocks)
    if not has_text:
        raise ValueError("Vietnamese subtitle file has no text content for TTS.")

    chunk_dir = LOG_DIR / "tts_chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    timeline_paths = []
    current_time_ms = 0

    for i, block in enumerate(tqdm(blocks, desc="TTS timeline")):
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
            continue

        raw_mp3_path = chunk_dir / f"raw_{i:04d}.mp3"
        final_seg_path = chunk_dir / f"part_{i:04d}.wav"

        def run_tts(rate):
            sleep_ms = max(0, int(STEP3_TTS_REQUEST_SLEEP_MS))
            if sleep_ms > 0:
                time.sleep(sleep_ms / 1000.0)
            asyncio.run(_generate_edge_tts_mp3(subtitle_text, raw_mp3_path, rate))

        tts_rate, boosted = resolve_dynamic_tts_rate(subtitle_text, subtitle_duration_ms)
        subtitle_idx = block.get("index", i + 1)
        char_count = len(re.sub(r"\s+", "", subtitle_text))
        text_preview = make_text_preview(subtitle_text, max_len=96)
        log(
            f"Step3 TTS request: subtitle_idx={subtitle_idx}, timeline_idx={i}, "
            f"char_count={char_count}, rate={tts_rate}, preview='{text_preview}'"
        )
        if boosted:
            log(f"Step3: subtitle {i} auto-rate boost -> {tts_rate}")

        retry_call(lambda: run_tts(tts_rate), f"TTS subtitle {i}", max_retry=TTS_RETRY_MAX)

        raw_segment_ms = get_media_duration_ms(raw_mp3_path)
        if (
            STEP3_AUTO_RATE_ENABLED
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
                    log(
                        f"Step3: subtitle {i} auto-rate second pass (raw {stretch_pre:.2f}x vs slot) "
                        f"{tts_rate} -> {tts_rate_2}"
                    )
                    tts_rate = tts_rate_2
                    retry_call(
                        lambda: run_tts(tts_rate),
                        f"TTS subtitle {i} retry",
                        max_retry=TTS_RETRY_MAX,
                    )
                    raw_segment_ms = get_media_duration_ms(raw_mp3_path)

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
                str(raw_mp3_path),
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
    log("Step4: Merging narration audio...")
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
                *ffmpeg_output_metadata_args(),
                str(out),
            ],
            "Merge narration audio",
        )
        return out

    if s <= 0:
        raise ValueError(f"step4-merge-speed must be > 0, got {s}")

    log(f"Step4: pre-merge speed {s:.4f}x (setpts + atempo on video & both audio tracks)")
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
            *ffmpeg_output_metadata_args(),
            str(out),
        ],
        "Merge narration audio (pre-merge speed)",
    )
    return out


def step7_apply_speed(video_path):
    if abs(float(SPEED_VIDEO) - 1.0) < 1e-6:
        return video_path

    speed = float(SPEED_VIDEO)
    if speed <= 0:
        raise ValueError(f"speed-video must be > 0, got {speed}")

    log(f"Step7: final speed x{speed:.4f} (after subtitle render)")
    out = VIDEO_DIR / f"{WORK_NAME}_vs_tm_x{speed:.2f}.mp4"
    atempo_filter = build_atempo_filter(speed)
    run_command(
        [
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
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-c:a",
            "aac",
            *ffmpeg_output_metadata_args(),
            str(out),
        ],
        f"Apply speed-video x{speed:.3f}",
    )
    return out


# ==============================
# STEP 5
# convert srt -> ass
# ==============================

def step5_convert_ass(srt_path):
    log("Step5: Convert subtitle to ASS")
    ass = SUBTITLE_DIR / "sub.ass"
    run_command([FFMPEG_BIN, "-y", "-i", str(srt_path), str(ass)], "Convert SRT to ASS")
    update_ass_default_style(ass)
    log(
        "Subtitle style updated: "
        f"font={SUBTITLE_FONT}, size={SUBTITLE_FONTSIZE}, "
        f"outline={SUBTITLE_OUTLINE}, shadow={SUBTITLE_SHADOW}, "
        f"alignment={SUBTITLE_ALIGNMENT}, margin_v={SUBTITLE_MARGIN_V}."
    )
    return ass


# ==============================
# STEP 6
# render subtitle
# ==============================

def step6_render(video_path, ass_path):
    log("Step6: Rendering subtitles...")
    if STEP6_VISUAL_TRANSFORM_ENABLED:
        log(
            "Step6: Visual transform: "
            f"hflip={STEP6_HFLIP}, zoom={STEP6_ZOOM_PERCENT}%, "
            f"sat={STEP6_EQ_SATURATION}, contrast={STEP6_EQ_CONTRAST}, unsharp={STEP6_UNSHARP}"
        )
    out = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    subtitle_filter = build_subtitle_filter(ass_path)
    configured_logo = Path(LOGO_FILE)
    # Resolve relative logo paths from this script directory
    # so changing LOGO_FILE in code always takes effect.
    logo_path = (
        configured_logo
        if configured_logo.is_absolute()
        else (SCRIPT_DIR / configured_logo)
    ).resolve()
    if file_ready(logo_path):
        log(f"Step6: Using logo overlay from {logo_path}")
    else:
        log(f"Step6: Logo not found ({logo_path}), render without logo.")
        logo_path = None

    gpu_cmd = build_step6_render_command(
        video_path, out, subtitle_filter, use_gpu=True, logo_path=logo_path
    )
    try:
        run_command(gpu_cmd, "Render ASS subtitles (GPU)")
        log("Step6 render used GPU (h264_nvenc).")
    except Exception as e:
        log(f"GPU render unavailable, fallback CPU: {e}")
        cpu_cmd = build_step6_render_command(
            video_path, out, subtitle_filter, use_gpu=False, logo_path=logo_path
        )
        run_command(cpu_cmd, "Render ASS subtitles (CPU fallback)")
    return out


def get_or_run(path, step_name, step_func, *args):
    p = Path(path)
    if file_ready(p):
        log(f"{step_name}: reuse existing {p}")
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
        "--subtitle-bg-blur-width-ratio", type=float, default=SUBTITLE_BG_BLUR_WIDTH_RATIO
    )
    parser.add_argument("--subtitle-bg-blur-height", type=int, default=SUBTITLE_BG_BLUR_HEIGHT)
    parser.add_argument(
        "--subtitle-bg-blur-bottom-offset", type=int, default=SUBTITLE_BG_BLUR_BOTTOM_OFFSET
    )
    parser.add_argument(
        "--subtitle-bg-blur-luma-radius", type=int, default=SUBTITLE_BG_BLUR_LUMA_RADIUS
    )
    parser.add_argument(
        "--subtitle-bg-blur-luma-power", type=int, default=SUBTITLE_BG_BLUR_LUMA_POWER
    )
    parser.add_argument(
        "--subtitle-bg-blur-chroma-radius", type=int, default=SUBTITLE_BG_BLUR_CHROMA_RADIUS
    )
    parser.add_argument(
        "--subtitle-bg-blur-chroma-power", type=int, default=SUBTITLE_BG_BLUR_CHROMA_POWER
    )

    # Logo options
    parser.add_argument("--logo-file", default=LOGO_FILE)
    parser.add_argument("--logo-width", type=int, default=LOGO_WIDTH)
    parser.add_argument("--logo-margin-x", type=int, default=LOGO_MARGIN_X)
    parser.add_argument("--logo-margin-y", type=int, default=LOGO_MARGIN_Y)
    parser.add_argument("--logo-opacity", type=float, default=LOGO_OPACITY)
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
    parser.add_argument("--step6-eq-saturation", type=float, default=STEP6_EQ_SATURATION)
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
    parser.add_argument("--metadata-title", default=OUTPUT_METADATA_TITLE, help="MP4 metadata title (channel).")
    parser.add_argument("--metadata-artist", default=OUTPUT_METADATA_ARTIST, help="MP4 metadata artist.")
    parser.add_argument("--metadata-comment", default=OUTPUT_METADATA_COMMENT, help="MP4 metadata comment.")

    # Audio and speed options
    parser.add_argument("--original-volume", type=float, default=ORIGINAL_AUDIO_VOLUME)
    parser.add_argument("--narration-volume", type=float, default=NARRATION_AUDIO_VOLUME)
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
        help="Step7 after subtitle render: final speed on *_vs_tm*.mp4 (e.g. 0.97). 1.0 = skip Step7 encode.",
    )
    parser.add_argument(
        "--whisper-language",
        default=WHISPER_LANGUAGE,
        help="Whisper language code. Example: zh, en, vi.",
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


def apply_cli_config(args):
    global WHISPER_LANGUAGE
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
    global STEP6_VISUAL_TRANSFORM_ENABLED
    global STEP6_HFLIP
    global STEP6_ZOOM_PERCENT
    global STEP6_EQ_SATURATION
    global STEP6_EQ_CONTRAST
    global STEP6_UNSHARP
    global OUTPUT_METADATA_ENABLED
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
    global TRANSLATION_CONTEXT
    WHISPER_LANGUAGE = str(args.whisper_language).strip() or None
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

    STEP6_VISUAL_TRANSFORM_ENABLED = args.step6_visual_transform == "on"
    STEP6_HFLIP = args.step6_hflip == "on"
    STEP6_ZOOM_PERCENT = float(args.step6_zoom_percent)
    STEP6_EQ_SATURATION = float(args.step6_eq_saturation)
    STEP6_EQ_CONTRAST = float(args.step6_eq_contrast)
    STEP6_UNSHARP = str(args.step6_unsharp).strip() or "5:5:0.8:3:3:0.0"

    OUTPUT_METADATA_ENABLED = args.output_metadata == "on"
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
    TRANSLATION_CONTEXT = args.translation_context or ""

    prof = STEP1_PROFILES[args.mode]
    STEP1_VAD_FILTER = args.step1_vad == "on"
    STEP1_VAD_THRESHOLD = (
        args.step1_vad_threshold if args.step1_vad_threshold is not None else prof["vad_threshold"]
    )
    STEP1_MIN_SILENCE_MS = (
        args.step1_min_silence_ms if args.step1_min_silence_ms is not None else prof["min_silence_ms"]
    )
    STEP1_MIN_SPEECH_MS = (
        args.step1_min_speech_ms if args.step1_min_speech_ms is not None else prof["min_speech_ms"]
    )
    STEP1_SPEECH_PAD_MS = (
        args.step1_speech_pad_ms if args.step1_speech_pad_ms is not None else prof["speech_pad_ms"]
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
        raise ValueError(f"--step out of range. Supported steps: {min_step}..{max_step}.")
    if start_step > end_step:
        raise ValueError("--step range invalid: start must be <= end.")
    return start_step, end_step


def require_ready(path, label):
    p = Path(path)
    if not file_ready(p):
        raise RuntimeError(f"{label} missing: {p}")
    return p


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
    if video_duration_ms:
        log(f"Input video duration: {video_duration_ms / 1000:.3f}s")
    else:
        log("Warning: input video duration unavailable; voice timeline uses subtitle end only.")

    start_step, end_step = parse_step_range(step_arg)
    log(f"Run step range: {start_step}..{end_step}")

    def step_enabled(step_no):
        return start_step <= step_no <= end_step

    zh_srt = get_zh_srt_path()
    vi_srt = get_vi_srt_path()
    voice = VIDEO_DIR / f"{WORK_NAME}_voice.wav"
    tm_video = VIDEO_DIR / f"{WORK_NAME}_tm.mp4"
    ass = SUBTITLE_DIR / "sub.ass"
    final = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    last_output = None

    if step_enabled(1):
        zh_srt = get_or_run(zh_srt, "Step1", step1_transcribe, video_path)
        last_output = zh_srt

    if step_enabled(2):
        require_ready(zh_srt, "Step2 input zh subtitle")
        vi_srt = get_or_run(vi_srt, "Step2", step2_translate_srt, zh_srt)
        last_output = vi_srt

    if SKIP_VOICE_STEP:
        if step_enabled(3) or step_enabled(4):
            log("Skip voice steps enabled: Step3/Step4 are skipped.")
    else:
        if step_enabled(3):
            require_ready(vi_srt, "Step3 input vi subtitle")
            voice = get_or_run(
                voice,
                "Step3",
                step3_generate_voice_from_srt,
                vi_srt,
                video_duration_ms,
            )
            last_output = voice
        if step_enabled(4):
            require_ready(voice, "Step4 input voice.wav")
            tm_video = get_or_run(tm_video, "Step4", step4_merge_audio, video_path, voice)
            last_output = tm_video

    if step_enabled(5):
        require_ready(vi_srt, "Step5 input vi subtitle")
        ass = get_or_run(ass, "Step5", step5_convert_ass, vi_srt)
        last_output = ass

    if step_enabled(6):
        require_ready(ass, "Step6 input sub.ass")
        if SKIP_VOICE_STEP:
            video_for_render = video_path
        else:
            video_for_render = require_ready(tm_video, "Step6 input merged video (_tm.mp4)")
        # Re-apply subtitle style even when ASS is reused from cache.
        update_ass_default_style(ass)
        final = step6_render(video_for_render, ass)
        final = step7_apply_speed(final)
        if not file_ready(final):
            raise RuntimeError("Final video render failed.")
        # cleanup_step6_intermediate_files()
        log(f"DONE: {final}")
        last_output = final
    else:
        log("Stopped before Step6 by --step option.")

    return last_output


# ==============================
# ENTRY
# ==============================

if __name__ == "__main__":
    args = parse_cli_args()
    apply_cli_config(args)
    try:
        run_pipeline(args.video, args.step)
    except Exception as e:
        log(f"ERROR: {e}")
        log(traceback.format_exc())
        raise