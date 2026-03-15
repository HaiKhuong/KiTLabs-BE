import argparse
import json
import os
import re
import shutil
import subprocess
import time
import asyncio
import traceback
from pathlib import Path

from google import genai
from tqdm import tqdm

# ==============================
# CONFIG
# ==============================

WHISPER_MODEL = "large-v3"
WHISPER_LANGUAGE = "zh"
GEMINI_MODEL_NAME = "gemini-2.5-flash"
EDGE_TTS_VOICE = "vi-VN-HoaiMyNeural"
EDGE_TTS_RATE = "+60%"
EDGE_TTS_VOLUME = "+0%"
EDGE_TTS_PITCH = "+0Hz"
# Optional: set absolute ffmpeg.exe path here if needed.
FFMPEG_PATH = ""

WORK_ROOT = Path("workspace")
WORK_NAME = "default"
WORK_DIR = WORK_ROOT / WORK_NAME
VIDEO_DIR = WORK_DIR / "videos"
SUBTITLE_DIR = WORK_DIR / "subtitles"
LOG_DIR = WORK_DIR / "logs"
LOG_PATH = LOG_DIR / "pipeline.log"
TRANSLATE_BATCH_SIZE = 500
TTS_CHUNK_MAX_CHARS = 350
RETRY_MAX = 4
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
ORIGINAL_AUDIO_VOLUME = 0.1
NARRATION_AUDIO_VOLUME = 1.0
SPEED_VIDEO = 1.0
STEP1_VAD_FILTER = True
STEP1_VAD_THRESHOLD = 0.45
STEP1_MIN_SILENCE_MS = 500
STEP1_MIN_SPEECH_MS = 180
STEP1_SPEECH_PAD_MS = 120
STEP1_NO_SPEECH_THRESHOLD = 0.7
STEP1_LOGPROB_THRESHOLD = -1.0
STEP1_CONDITION_ON_PREVIOUS_TEXT = False

API_KEY = "AIzaSyC1W6ml6VlzqmQ6kLrgR6Tw2AGVeCv_MDc"
if API_KEY:
    GEMINI_CLIENT = genai.Client(api_key=API_KEY)
else:
    GEMINI_CLIENT = None


# ==============================
# HELPER
# ==============================

def log(message):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {message}"
    with open(LOG_PATH, "a", encoding="utf8") as f:
        f.write(line + "\n")
    print(message)


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
        raise EnvironmentError("Missing API_KEY in script config.")
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
            f.write(f"{b['text']}\n\n")


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


def build_subtitle_filter(ass_path):
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


def build_step6_render_command(video_path, out_path, subtitle_filter, use_gpu, logo_path=None):
    input_args = ["-i", str(video_path)]
    filter_arg_key = "-vf"
    filter_arg_value = subtitle_filter
    map_args = []

    if logo_path:
        logo_filter = (
            f"[1:v]format=rgba,scale={int(LOGO_WIDTH)}:-1,colorchannelmixer=aa={float(LOGO_OPACITY)}[logo];"
            f"[vsub][logo]overlay={int(LOGO_MARGIN_X)}:{int(LOGO_MARGIN_Y)}[vout]"
        )
        filter_arg_key = "-filter_complex"
        filter_arg_value = f"{subtitle_filter};{logo_filter}"
        input_args.extend(["-i", str(logo_path)])
        map_args = ["-map", "[vout]", "-map", "0:a?"]

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
# Whisper -> zh.srt
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
        with open(out_path, "w", encoding="utf8") as f:
            for i, segment in enumerate(tqdm(segments, desc=f"Transcribe ({device_name})")):
                count = i + 1
                last_end_ms = int(float(segment.end) * 1000)
                f.write(f"{count}\n")
                f.write(f"{fmt_time(segment.start)} --> {fmt_time(segment.end)}\n")
                f.write(f"{segment.text.strip()}\n\n")
                if count % 50 == 0:
                    log(
                        f"Step1 {device_name}: {count} segments, "
                        f"last_end={last_end_ms / 1000:.2f}s"
                    )
        return count, last_end_ms

    srt_path = SUBTITLE_DIR / "zh.srt"

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
    prompt = (
        "Translate Chinese subtitles into Vietnamese.\n"
        "Context: Chinese historical / wuxia / xianxia animation.\n"
        "Write very concise, subtitle-friendly Vietnamese.\n"
        "Prefer short words and compact sentence structure; remove filler words.\n"
        "Keep original meaning and emotional tone, but simplify phrasing.\n"
        "Preserve historical tone, titles, names, and relationships.\n"
        "Use Sino-Vietnamese (Han-Viet) pronouns/family terms when appropriate.\n"
        "Examples: Người Tôm => Hà Nhân, Thượng vị => hoàng thượng, cha => phụ thân, mẹ => mẫu thân, anh trai => huynh trưởng, em trai => đệ đệ.\n"
        "Avoid verbose or literary wording unless required by context.\n"
        "Do NOT explain anything.\n"
        "Return ONLY JSON array, exact schema: [{\"id\":0,\"vi\":\"...\"}]\n"
        f"Input JSON:\n{json.dumps(payload, ensure_ascii=False)}"
    )

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

    out_path = SUBTITLE_DIR / "vi.srt"
    write_srt(translated_blocks, out_path)
    return out_path


# ==============================
# STEP 3
# TTS generate voice directly from SRT (chunked)
# ==============================

def step3_generate_voice_from_srt(srt_path, target_duration_ms=None):
    log("Step3: Generating voice with edge-tts (timeline by SRT)...")
    import edge_tts

    async def _generate_edge_tts_mp3(text, out_path):
        communicate = edge_tts.Communicate(
            text=text,
            voice=EDGE_TTS_VOICE,
            rate=EDGE_TTS_RATE,
            volume=EDGE_TTS_VOLUME,
            pitch=EDGE_TTS_PITCH,
        )
        await communicate.save(str(out_path))

    with open(srt_path, encoding="utf8") as f:
        blocks = parse_srt(f.read())
    if not blocks:
        raise ValueError("vi.srt has no valid subtitle blocks.")

    has_text = any(b["text"].strip() for b in blocks)
    if not has_text:
        raise ValueError("vi.srt has no text content for TTS.")

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
        subtitle_text = block["text"].replace("\n", " ").strip()

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

        def _call():
            asyncio.run(_generate_edge_tts_mp3(subtitle_text, raw_mp3_path))

        retry_call(_call, f"TTS subtitle {i}")

        # Force segment duration to exactly match subtitle duration (trim/pad).
        run_command(
            [
                FFMPEG_BIN,
                "-y",
                "-i",
                str(raw_mp3_path),
                "-af",
                (
                    f"apad=pad_dur={subtitle_duration_ms / 1000:.3f},"
                    f"atrim=duration={subtitle_duration_ms / 1000:.3f}"
                ),
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
        current_time_ms = end_ms

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
            str(out),
        ],
        "Merge narration audio",
    )
    return out


def step7_apply_speed(video_path):
    if abs(float(SPEED_VIDEO) - 1.0) < 1e-6:
        return video_path

    speed = float(SPEED_VIDEO)
    if speed <= 0:
        raise ValueError(f"speed-video must be > 0, got {speed}")

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
    out = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    subtitle_filter = build_subtitle_filter(ass_path)
    logo_path = Path(LOGO_FILE).resolve()
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

    # Audio and speed options
    parser.add_argument("--original-volume", type=float, default=ORIGINAL_AUDIO_VOLUME)
    parser.add_argument("--narration-volume", type=float, default=NARRATION_AUDIO_VOLUME)
    parser.add_argument("--speed-video", type=float, default=SPEED_VIDEO)
    parser.add_argument(
        "--whisper-language",
        default=WHISPER_LANGUAGE,
        help="Whisper language code. Example: zh, en, vi.",
    )
    parser.add_argument(
        "--step1-vad",
        choices=["on", "off"],
        default="on" if STEP1_VAD_FILTER else "off",
        help="Enable/disable VAD filter in Step1 to reduce music/noise transcription.",
    )
    parser.add_argument("--step1-vad-threshold", type=float, default=STEP1_VAD_THRESHOLD)
    parser.add_argument("--step1-min-silence-ms", type=int, default=STEP1_MIN_SILENCE_MS)
    parser.add_argument("--step1-min-speech-ms", type=int, default=STEP1_MIN_SPEECH_MS)
    parser.add_argument("--step1-speech-pad-ms", type=int, default=STEP1_SPEECH_PAD_MS)
    parser.add_argument(
        "--step1-no-speech-threshold",
        type=float,
        default=STEP1_NO_SPEECH_THRESHOLD,
        help="Higher values skip non-speech more aggressively.",
    )
    parser.add_argument("--step1-logprob-threshold", type=float, default=STEP1_LOGPROB_THRESHOLD)
    parser.add_argument(
        "--step1-condition-on-previous-text",
        choices=["on", "off"],
        default="on" if STEP1_CONDITION_ON_PREVIOUS_TEXT else "off",
        help="Use previous text as context; off can reduce hallucination around music.",
    )
    parser.add_argument("--edge-tts-voice", default=EDGE_TTS_VOICE)
    parser.add_argument("--edge-tts-rate", default=EDGE_TTS_RATE)
    parser.add_argument("--edge-tts-volume", default=EDGE_TTS_VOLUME)
    parser.add_argument("--edge-tts-pitch", default=EDGE_TTS_PITCH)
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
    global ORIGINAL_AUDIO_VOLUME
    global NARRATION_AUDIO_VOLUME
    global SPEED_VIDEO
    global STEP1_VAD_FILTER
    global STEP1_VAD_THRESHOLD
    global STEP1_MIN_SILENCE_MS
    global STEP1_MIN_SPEECH_MS
    global STEP1_SPEECH_PAD_MS
    global STEP1_NO_SPEECH_THRESHOLD
    global STEP1_LOGPROB_THRESHOLD
    global STEP1_CONDITION_ON_PREVIOUS_TEXT
    global EDGE_TTS_VOICE
    WHISPER_LANGUAGE = str(args.whisper_language).strip() or None
    global EDGE_TTS_RATE
    global EDGE_TTS_VOLUME
    global EDGE_TTS_PITCH

    SUBTITLE_FONT = args.subtitle_font
    SUBTITLE_FONTSIZE = args.subtitle_fontsize
    SUBTITLE_PRIMARY_COLOUR = args.subtitle_primary_colour
    SUBTITLE_OUTLINE_COLOUR = args.subtitle_outline_colour
    SUBTITLE_OUTLINE = args.subtitle_outline
    SUBTITLE_SHADOW = args.subtitle_shadow
    SUBTITLE_ALIGNMENT = args.subtitle_alignment
    SUBTITLE_MARGIN_V = args.subtitle_margin_v
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
    ORIGINAL_AUDIO_VOLUME = args.original_volume
    NARRATION_AUDIO_VOLUME = args.narration_volume
    SPEED_VIDEO = args.speed_video
    STEP1_VAD_FILTER = args.step1_vad == "on"
    STEP1_VAD_THRESHOLD = args.step1_vad_threshold
    STEP1_MIN_SILENCE_MS = args.step1_min_silence_ms
    STEP1_MIN_SPEECH_MS = args.step1_min_speech_ms
    STEP1_SPEECH_PAD_MS = args.step1_speech_pad_ms
    STEP1_NO_SPEECH_THRESHOLD = args.step1_no_speech_threshold
    STEP1_LOGPROB_THRESHOLD = args.step1_logprob_threshold
    STEP1_CONDITION_ON_PREVIOUS_TEXT = args.step1_condition_on_previous_text == "on"
    EDGE_TTS_VOICE = args.edge_tts_voice
    EDGE_TTS_RATE = args.edge_tts_rate
    EDGE_TTS_VOLUME = args.edge_tts_volume
    EDGE_TTS_PITCH = args.edge_tts_pitch


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

    zh_srt = SUBTITLE_DIR / "zh.srt"
    vi_srt = SUBTITLE_DIR / "vi.srt"
    voice = VIDEO_DIR / f"{WORK_NAME}_voice.wav"
    tm_video = VIDEO_DIR / f"{WORK_NAME}_tm.mp4"
    ass = SUBTITLE_DIR / "sub.ass"
    final = VIDEO_DIR / f"{WORK_NAME}_vs_tm.mp4"
    last_output = None

    if step_enabled(1):
        zh_srt = get_or_run(zh_srt, "Step1", step1_transcribe, video_path)
        last_output = zh_srt

    if step_enabled(2):
        require_ready(zh_srt, "Step2 input zh.srt")
        vi_srt = get_or_run(vi_srt, "Step2", step2_translate_srt, zh_srt)
        last_output = vi_srt

    if SKIP_VOICE_STEP:
        if step_enabled(3) or step_enabled(4):
            log("Skip voice steps enabled: Step3/Step4 are skipped.")
    else:
        if step_enabled(3):
            require_ready(vi_srt, "Step3 input vi.srt")
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
        require_ready(vi_srt, "Step5 input vi.srt")
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