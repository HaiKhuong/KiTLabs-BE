"""
TTS OmniVoice theo đoạn + chèn khoảng lặng sau dấu câu / xuống dòng (audio tools).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

from omnivoice_tts import _normalize_tts_text_for_audio, synthesize_to_wav

FFMPEG_BIN = (os.getenv("FFMPEG_BIN") or "ffmpeg").strip() or "ffmpeg"
DEFAULT_PAUSE_SEC = {
    "period": 0.45,
    "comma": 0.25,
    "semicolon": 0.3,
    "newline": 0.6,
}


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
    return t.strip()


def _is_speakable_piece(piece: str) -> bool:
    """True nếu sau chuẩn hóa OmniVoice vẫn còn nội dung để synthesize."""
    return bool(_normalize_tts_text_for_audio(str(piece or "").strip()))


def _append_pause_only(chunks: List[Dict[str, Optional[str]]], pause_after: str) -> None:
    """Gộp pause liên tiếp cùng loại (vd. nhiều \\n liền nhau)."""
    if chunks and chunks[-1].get("text") is None and chunks[-1].get("pause_after") == pause_after:
        return
    chunks.append({"text": None, "pause_after": pause_after})


def _tokenize_with_pauses(text: str) -> List[Dict[str, Optional[str]]]:
    """Tách văn bản; mỗi phần có pause_after: period | comma | semicolon | newline | None."""
    t = _prepare_text_for_pause_tokenize(text)
    if not t:
        return []

    delim_map = {".": "period", ",": "comma", ";": "semicolon", "\n": "newline"}
    tokens = re.split(r"([.,;\n])", t)
    chunks: List[Dict[str, Optional[str]]] = []
    buf: List[str] = []

    def flush(pause_after: Optional[str]) -> None:
        piece = "".join(buf).strip()
        buf.clear()
        if piece and _is_speakable_piece(piece):
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

    # Bỏ pause_after ở chunk cuối nếu không có text (chỉ silence thừa)
    while chunks and chunks[-1].get("text") is None:
        chunks.pop()

    return chunks


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
    device_map: str,
    dtype_str: str = "float16",
    language: str = "vietnamese",
    num_step: Optional[int] = 8,
    guidance_scale: Optional[float] = 2.0,
    seed: Optional[int] = None,
    pause_settings: Optional[Dict[str, Any]] = None,
    playback_speed: Optional[float] = None,
) -> None:
    out = Path(out_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    pause_sec = _resolve_pause_sec(pause_settings)
    chunks = _tokenize_with_pauses(text)

    if not chunks:
        raise ValueError("text is empty after tokenize")

    omnivoice_kw = dict(
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        language=language,
        num_step=num_step,
        guidance_scale=guidance_scale,
        seed=seed,
    )

    speed = _resolve_playback_speed(playback_speed)

    speakable = [c for c in chunks if c.get("text") and _is_speakable_piece(str(c["text"]))]

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
                    sil_path = tmp_dir / f"sil_only_{i:04d}.wav"
                    _write_silence_wav(sil_path, pause_sec[pause_key])
                    if sil_path.is_file() and sil_path.stat().st_size > 0:
                        timeline.append(sil_path)
            _concat_wavs(timeline, out)
        _apply_playback_speed(out, speed)
        return

    # Một đoạn nói, không pause sau đoạn → gọi trực tiếp (nhanh hơn)
    if len(chunks) == 1 and chunks[0].get("text") and not chunks[0].get("pause_after"):
        synthesize_to_wav(text=str(chunks[0]["text"]), out_wav=out, **omnivoice_kw)
        _apply_playback_speed(out, speed)
        return

    timeline: List[Path] = []
    with tempfile.TemporaryDirectory(prefix="audio_pause_") as tmp:
        tmp_dir = Path(tmp)
        for i, chunk in enumerate(chunks):
            piece = str(chunk.get("text") or "").strip()
            if piece and _is_speakable_piece(piece):
                seg_path = tmp_dir / f"seg_{i:04d}.wav"
                synthesize_to_wav(text=piece, out_wav=seg_path, **omnivoice_kw)
                timeline.append(seg_path)

            pause_key = chunk.get("pause_after")
            if pause_key and pause_key in pause_sec:
                sil_path = tmp_dir / f"sil_{i:04d}.wav"
                _write_silence_wav(sil_path, pause_sec[pause_key])
                if sil_path.is_file() and sil_path.stat().st_size > 0:
                    timeline.append(sil_path)

        _concat_wavs(timeline, out)

    _apply_playback_speed(out, speed)


if __name__ == "__main__":
    payload = json.load(sys.stdin)
    synthesize_with_pause_settings(**payload)
