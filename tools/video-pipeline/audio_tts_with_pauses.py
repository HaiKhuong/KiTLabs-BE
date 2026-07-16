"""
TTS OmniVoice / VoxCPM2 theo đoạn + chèn khoảng lặng sau dấu câu / xuống dòng (audio tools).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import pipeline_cache  # noqa: F401 — HF cache → tools/video-pipeline/cache
from omnivoice_tts import (
    prepare_omnivoice_input_text,
    resolve_omnivoice_language,
    synthesize_to_wav as synthesize_omnivoice_to_wav,
)

FFMPEG_BIN = (os.getenv("FFMPEG_BIN") or "ffmpeg").strip() or "ffmpeg"
_step3_ref_cfg_ready = False
DEFAULT_PAUSE_SEC = {
    "period": 0.45,
    "comma": 0.25,
    "semicolon": 0.3,
    "newline": 0.6,
    "question": 0.45,
    "exclamation": 0.45,
    "colon": 0.3,
    "ellipsis": 0.55,
}

# Ký tự placeholder sau khi gom "..." / "...." (tránh tách thành nhiều dấu chấm).
ELLIPSIS_CHAR = "\u2026"


# Đệm im lặng sau mỗi đoạn TTS (ms) — tránh cảm giác bị cắt đuôi trước khi nghỉ.
def _resolve_tail_pad_sec() -> float:
    raw = (os.getenv("AUDIO_TTS_TAIL_PAD_MS") or "350").strip()
    try:
        ms = float(raw)
    except (TypeError, ValueError):
        ms = 350.0
    return max(0.0, min(ms / 1000.0, 1.5))


def _resolve_pause_sec(pause_settings: Optional[Dict[str, Any]]) -> Dict[str, float]:
    raw = pause_settings or {}
    out: Dict[str, float] = dict(DEFAULT_PAUSE_SEC)
    for key in out:
        val = raw.get(key)
        if val is None:
            continue
        try:
            sec = float(val)
        except (TypeError, ValueError):
            continue
        out[key] = max(0.0, min(sec, 3.0))
    return out


def _prepare_text_for_pause_tokenize(text: str) -> str:
    """Gom khoảng trắng / xuống dòng thừa trước khi tách đoạn TTS."""
    t = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    # Khoảng trắng Unicode (NBSP, zero-width…) → space thường
    t = re.sub(r"[\u00a0\u200b\u200c\u200d\ufeff]+", " ", t)
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r" *\n+ *", "\n", t)
    t = re.sub(r"\n{2,}", "\n", t)
    t = re.sub(r" +", " ", t)
    # Ba chấm trở lên (có/không khoảng trắng xen) → một dấu …
    t = re.sub(r"\s*\.\s*\.\s*\.\s*", ELLIPSIS_CHAR, t)
    t = re.sub(r"\.{3,}", ELLIPSIS_CHAR, t)
    t = re.sub(r"[.…]{2,}", ELLIPSIS_CHAR, t)
    return t.strip()


def _resolve_tts_engine(raw: Any) -> str:
    key = str(raw or "omnivoice").strip().lower()
    return "voxcpm2" if key == "voxcpm2" else "omnivoice"


def _is_speakable_piece(piece: str, engine: str = "omnivoice", language: str | None = None) -> bool:
    """True nếu sau chuẩn hóa engine vẫn còn nội dung để synthesize."""
    text = str(piece or "").strip()
    if not text:
        return False
    if engine == "voxcpm2":
        from voxcpm2_tts import prepare_voxcpm2_input_text

        return bool(prepare_voxcpm2_input_text(text, language))
    return bool(prepare_omnivoice_input_text(text))


def _append_pause_only(chunks: List[Dict[str, Optional[str]]], pause_after: str) -> None:
    """Gộp pause liên tiếp cùng loại (vd. nhiều \\n liền nhau)."""
    if chunks and chunks[-1].get("text") is None and chunks[-1].get("pause_after") == pause_after:
        return
    chunks.append({"text": None, "pause_after": pause_after})


def _tokenize_line_with_pauses(
    line: str,
    engine: str = "omnivoice",
    language: str | None = None,
) -> List[Dict[str, Optional[str]]]:
    """
    Tách một dòng theo dấu kết thúc câu.

    Không tách tại dấu phẩy giữa dòng — TTS đọc trọn cụm, tránh nuốt chữ
    khi ghép nhiều segment quá ngắn.
    """
    line = str(line or "").strip()
    if not line:
        return []

    delim_map = {
        ".": "period",
        ";": "semicolon",
        "?": "question",
        "!": "exclamation",
        ":": "colon",
        ELLIPSIS_CHAR: "ellipsis",
    }
    tokens = re.split(r"(…|[.;?!:])", line)
    chunks: List[Dict[str, Optional[str]]] = []
    buf: List[str] = []

    def flush(pause_after: Optional[str]) -> None:
        piece = "".join(buf).strip()
        buf.clear()
        if piece and _is_speakable_piece(piece, engine, language):
            chunks.append({"text": piece, "pause_after": pause_after})
        elif pause_after:
            _append_pause_only(chunks, pause_after)

    for tok in tokens:
        if not tok:
            continue
        if tok in delim_map:
            flush(delim_map[tok])
        else:
            buf.append(tok)

    flush(None)
    return chunks


def _tokenize_with_pauses(
    text: str,
    engine: str = "omnivoice",
    language: str | None = None,
) -> List[Dict[str, Optional[str]]]:
    """
    Tách văn bản thành đoạn TTS + pause_after.

    - Trong mỗi dòng: tách theo . ; ? ! : …
    - Dấu phẩy giữa dòng: giữ nguyên (không tách)
    - Xuống dòng: đoạn cuối mỗi dòng dùng pause newline (trừ dòng cuối)
    """
    t = _prepare_text_for_pause_tokenize(text)
    if not t:
        return []

    lines = t.split("\n")
    chunks: List[Dict[str, Optional[str]]] = []

    for line_idx, line in enumerate(lines):
        line_chunks = _tokenize_line_with_pauses(line, engine, language)
        if not line_chunks:
            if line_idx < len(lines) - 1:
                _append_pause_only(chunks, "newline")
            continue

        is_last_line = line_idx == len(lines) - 1
        for chunk_idx, chunk in enumerate(line_chunks):
            is_last_chunk_in_line = chunk_idx == len(line_chunks) - 1
            if is_last_chunk_in_line and not is_last_line and chunk.get("text"):
                chunk = dict(chunk)
                chunk["pause_after"] = "newline"
            chunks.append(chunk)

    while chunks and chunks[-1].get("text") is None:
        chunks.pop()

    return chunks


def _run_command(args: List[str], label: str) -> None:
    """Tương thích signature run_command của auto_vietsub / step3_edge."""
    proc = subprocess.run(args, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{label} failed: {err[:2000]}")


def _ensure_step3_speaker_ref_config() -> None:
    """Cấu hình tối thiểu để dùng prepare_speaker_reference (mp3/m4a → WAV 24kHz mono)."""
    global _step3_ref_cfg_ready
    if _step3_ref_cfg_ready:
        return
    from step3_edge import configure_step3_edge

    configure_step3_edge(
        log=lambda _msg: None,
        run_command=_run_command,
        ffmpeg_bin=FFMPEG_BIN,
        edge_tts_voice="",
        edge_tts_volume="",
        edge_tts_pitch="",
        step3_tts_api_timeout_sec=60.0,
    )
    _step3_ref_cfg_ready = True


def _resolve_ref_audio_cache_dir(ref_path: Path) -> Path:
    root = (os.getenv("AUDIO_REF_CACHE_DIR") or "").strip()
    base = Path(root) if root else Path(tempfile.gettempdir()) / "kitools_audio_ref"
    return base / ref_path.stem


def _prepare_ref_audio_for_omnivoice(ref_audio: str | Path) -> Path:
    """WAV giữ nguyên; mp3/m4a/… → WAV 24kHz mono (cùng logic auto_vietsub Step3)."""
    ref_path = Path(ref_audio).expanduser().resolve()
    if not ref_path.is_file():
        raise FileNotFoundError(f"Reference audio not found: {ref_path}")
    if ref_path.suffix.lower() == ".wav":
        return ref_path
    _ensure_step3_speaker_ref_config()
    from step3_edge import prepare_speaker_reference

    return prepare_speaker_reference(ref_path, _resolve_ref_audio_cache_dir(ref_path))


def _resolve_omnivoice_seed(seed: Optional[int]) -> Optional[int]:
    if seed is not None:
        return int(seed)
    raw = (os.getenv("OMNIVOICE_SEED") or "42").strip()
    if not raw or raw.lower() in ("none", "null"):
        return None
    try:
        return int(raw)
    except ValueError:
        return 42


def _run_ffmpeg(args: List[str], label: str) -> None:
    cmd = [FFMPEG_BIN, "-y", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{label} failed: {err[:2000]}")


def _write_silence_wav(path: Path, duration_sec: float, sample_rate: int = 24000) -> None:
    dur = max(0.0, float(duration_sec))
    if dur <= 0.001:
        path.write_bytes(b"")
        return
    _run_ffmpeg(
        [
            "-f",
            "lavfi",
            "-i",
            f"anullsrc=r={sample_rate}:cl=mono",
            "-t",
            f"{dur:.3f}",
            "-acodec",
            "pcm_s16le",
            str(path),
        ],
        "Create silence",
    )


def _resolve_playback_speed(raw: Any) -> float:
    try:
        speed = float(raw)
    except (TypeError, ValueError):
        return 1.0
    return max(0.5, min(2.0, speed))


def _apply_playback_speed(wav_path: Path, speed: float) -> None:
    if abs(float(speed) - 1.0) < 1e-6:
        return
    tmp = wav_path.with_name(f"{wav_path.stem}_spd{wav_path.suffix}")
    _run_ffmpeg(
        [
            "-i",
            str(wav_path),
            "-af",
            f"atempo={float(speed):.4f}",
            "-acodec",
            "pcm_s16le",
            str(tmp),
        ],
        "Apply playback speed",
    )
    tmp.replace(wav_path)


def _append_silence_to_timeline(
    timeline: List[Path],
    path: Path,
    duration_sec: float,
) -> None:
    _write_silence_wav(path, duration_sec)
    if path.is_file() and path.stat().st_size > 0:
        timeline.append(path)


def _append_tts_segment(
    timeline: List[Path],
    tmp_dir: Path,
    index: int,
    piece: str,
    pause_after: Optional[str],
    pause_sec: Dict[str, float],
    tail_pad_sec: float,
    synthesize_fn: Callable[..., None],
    synth_kw: Dict[str, Any],
) -> None:
    seg_path = tmp_dir / f"seg_{index:04d}.wav"
    synthesize_fn(text=piece, out_wav=seg_path, **synth_kw)
    timeline.append(seg_path)

    # Luôn đệm đuôi sau mỗi đoạn nói — tránh cảm giác bị cắt trước khi chèn pause.
    if tail_pad_sec > 0.001:
        _append_silence_to_timeline(
            timeline,
            tmp_dir / f"tail_{index:04d}.wav",
            tail_pad_sec,
        )

    if pause_after and pause_after in pause_sec:
        _append_silence_to_timeline(
            timeline,
            tmp_dir / f"sil_{index:04d}.wav",
            pause_sec[pause_after],
        )


def _concat_wavs(paths: List[Path], out_wav: Path) -> None:
    valid = [p for p in paths if p.is_file() and p.stat().st_size > 0]
    if not valid:
        raise RuntimeError("No audio segments to concat")
    if len(valid) == 1:
        import shutil

        shutil.copy2(valid[0], out_wav)
        return

    list_file = out_wav.parent / f"_concat_{out_wav.stem}.txt"
    lines = [f"file '{str(p.resolve()).replace(chr(39), chr(39) + chr(39))}'" for p in valid]
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _run_ffmpeg(
        ["-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out_wav)],
        "Concat segments",
    )
    try:
        list_file.unlink(missing_ok=True)
    except OSError:
        pass


def synthesize_with_pause_settings(
    *,
    text: str,
    out_wav: str | Path,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str = "cuda:0",
    dtype_str: str = "float16",
    language: str | None = None,
    num_step: Optional[int] = 8,
    guidance_scale: Optional[float] = 2.0,
    cfg_value: Optional[float] = 2.0,
    inference_timesteps: Optional[int] = 10,
    seed: Optional[int] = None,
    pause_settings: Optional[Dict[str, Any]] = None,
    playback_speed: Optional[float] = None,
    engine: str = "omnivoice",
) -> None:
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    ref_prepared = _prepare_ref_audio_for_omnivoice(ref_audio)
    tts_engine = _resolve_tts_engine(engine)
    resolved_seed = _resolve_omnivoice_seed(seed)
    pause_sec = _resolve_pause_sec(pause_settings)

    if tts_engine == "voxcpm2":
        from voxcpm2_tts import resolve_voxcpm2_language, synthesize_to_wav as synthesize_voxcpm2_to_wav

        resolved_language = resolve_voxcpm2_language(language)
        synthesize_fn: Callable[..., None] = synthesize_voxcpm2_to_wav
        synth_kw: Dict[str, Any] = dict(
            ref_audio=str(ref_prepared),
            ref_text=ref_text,
            model_id=model_id or "openbmb/VoxCPM2",
            language=resolved_language,
            cfg_value=float(cfg_value if cfg_value is not None else 2.0),
            inference_timesteps=int(inference_timesteps if inference_timesteps is not None else 10),
            seed=resolved_seed,
        )
    else:
        resolved_language = resolve_omnivoice_language(language)
        synthesize_fn = synthesize_omnivoice_to_wav
        synth_kw = dict(
            ref_audio=str(ref_prepared),
            ref_text=ref_text,
            model_id=model_id,
            device_map=device_map,
            dtype_str=dtype_str,
            language=resolved_language,
            num_step=num_step,
            guidance_scale=guidance_scale,
            seed=resolved_seed,
        )

    chunks = _tokenize_with_pauses(text, tts_engine, resolved_language)

    if not chunks:
        raise ValueError("text is empty after tokenize")

    speed = _resolve_playback_speed(playback_speed)
    tail_pad_sec = _resolve_tail_pad_sec()

    speakable = [
        c
        for c in chunks
        if c.get("text") and _is_speakable_piece(str(c["text"]), tts_engine, resolved_language)
    ]

    # Chỉ còn silence (xuống dòng thừa) hoặc không có đoạn nói
    if not speakable:
        if not chunks:
            raise ValueError("text is empty after tokenize")
        timeline: List[Path] = []
        with tempfile.TemporaryDirectory(prefix="audio_pause_") as tmp:
            tmp_dir = Path(tmp)
            for i, chunk in enumerate(chunks):
                pause_key = chunk.get("pause_after")
                if pause_key and pause_key in pause_sec:
                    _append_silence_to_timeline(
                        timeline,
                        tmp_dir / f"sil_only_{i:04d}.wav",
                        pause_sec[pause_key],
                    )
            _concat_wavs(timeline, out)
        _apply_playback_speed(out, speed)
        return

    # Một đoạn nói, không pause sau đoạn → gọi trực tiếp (nhanh hơn)
    if len(chunks) == 1 and chunks[0].get("text") and not chunks[0].get("pause_after"):
        synthesize_fn(text=str(chunks[0]["text"]), out_wav=out, **synth_kw)
        _apply_playback_speed(out, speed)
        return

    timeline = []
    with tempfile.TemporaryDirectory(prefix="audio_pause_") as tmp:
        tmp_dir = Path(tmp)
        for i, chunk in enumerate(chunks):
            piece = str(chunk.get("text") or "").strip()
            pause_key = chunk.get("pause_after")
            if piece and _is_speakable_piece(piece, tts_engine, resolved_language):
                _append_tts_segment(
                    timeline,
                    tmp_dir,
                    i,
                    piece,
                    pause_key,
                    pause_sec,
                    tail_pad_sec,
                    synthesize_fn,
                    synth_kw,
                )
            elif pause_key and pause_key in pause_sec:
                _append_silence_to_timeline(
                    timeline,
                    tmp_dir / f"sil_{i:04d}.wav",
                    pause_sec[pause_key],
                )

        _concat_wavs(timeline, out)

    _apply_playback_speed(out, speed)


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    synthesize_with_pause_settings(**payload)
