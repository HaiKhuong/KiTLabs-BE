"""
Edge TTS và tiện ích Step3 dùng chung (prepare speaker ref, normalize vi).

Gọi configure_step3_edge(...) trước khi dùng run_edge_tts_mp3_save / prepare_speaker_reference.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any, Callable, Optional

_cfg: dict[str, Any] = {}


def configure_step3_edge(
    *,
    log: Callable[[str], None],
    run_command: Callable,
    ffmpeg_bin: str,
    edge_tts_voice: str,
    edge_tts_volume: str,
    edge_tts_pitch: str,
    step3_tts_api_timeout_sec: float,
) -> None:
    _cfg.clear()
    _cfg.update(
        log=log,
        run_command=run_command,
        ffmpeg_bin=ffmpeg_bin,
        edge_tts_voice=str(edge_tts_voice or ""),
        edge_tts_volume=str(edge_tts_volume or ""),
        edge_tts_pitch=str(edge_tts_pitch or ""),
        step3_tts_api_timeout_sec=float(step3_tts_api_timeout_sec),
    )


def _apply_tts_acronym_rules(t: str) -> str:
    """Thay viết tắt chữ cái → cách đọc tiếng Việt. Thứ tự: dài / có khoảng trắng trước."""
    t = re.sub(r"\bS\s+S\s+S\b", "Ba Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bSSS\b", "Ba Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bS\s+S\b", "Hai Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bSS\b", "Hai Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bS\b", "Ét", t, flags=re.IGNORECASE)
    t = re.sub(r"\bHACK\b", "Hách", t, flags=re.IGNORECASE)
    t = re.sub(r"\bMecha\b", "Mê cha", t, flags=re.IGNORECASE)
    t = re.sub(r"\bHaiz+\b", "Hài", t, flags=re.IGNORECASE)
    t = t.replace("A.I", "Ây Ai").replace("AI", "Ây Ai")
    # Lặp: "Đi thôi, đi thôi" / "Đi thôi. đi thôi" → "ĐI thôi"
    t = re.sub(
        r"\bđi\s+thôi\s*[,.]\s*đi\s+thôi\b",
        "Đi thôi",
        t,
        flags=re.IGNORECASE,
    )
    return t


def tts_normalize_vi(text, enabled: bool):
    if not enabled:
        return text
    try:
        from vinorm import TTSnorm
    except ImportError:
        return text
    s = _apply_tts_acronym_rules(str(text or ""))
    t = (
        TTSnorm(s, unknown=False, lower=False, rule=True)
        .replace("..", "")
        .replace("...", "")
        .replace("!.", "")
        .replace("?.", "")
        .replace(" .", "")
        .replace(" ,", "")
        .replace('"', "")
        .replace("'", "")
        .replace("/", " phần ")
        .replace("+", " Cộng ")
    )
    # vinorm đôi khi tách SS → "S S"; chạy lại sau normalize
    t = _apply_tts_acronym_rules(t)
    return t


def prepare_speaker_reference(speaker_in: Path, cache_dir: Path) -> Path:
    """WAV giữ nguyên; mp3/m4a/… → WAV 24kHz mono (OmniVoice / ref audio)."""
    p = Path(speaker_in).expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"Step3 TTS: không tìm thấy file giọng mẫu: {p}")
    if p.suffix.lower() == ".wav":
        return p
    cache_dir.mkdir(parents=True, exist_ok=True)
    out_wav = cache_dir / "speaker_ref_converted.wav"
    _cfg["run_command"](
        [
            _cfg["ffmpeg_bin"],
            "-y",
            "-i",
            str(p),
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            str(out_wav),
        ],
        f"Step3 TTS: chuyển giọng mẫu {p.suffix} → WAV 24kHz mono",
    )
    return out_wav.resolve()


async def edge_tts_save_mp3_async(text, out_path, rate: str) -> None:
    import edge_tts

    communicate = edge_tts.Communicate(
        text=text,
        voice=_cfg["edge_tts_voice"],
        rate=rate,
        volume=_cfg["edge_tts_volume"],
        pitch=_cfg["edge_tts_pitch"],
    )
    out = str(out_path)
    timeout_sec = float(_cfg["step3_tts_api_timeout_sec"])
    if timeout_sec <= 0:
        await communicate.save(out)
    else:
        try:
            await asyncio.wait_for(communicate.save(out), timeout=timeout_sec)
        except asyncio.TimeoutError as exc:
            raise TimeoutError(
                f"edge-tts request timed out after {timeout_sec:.1f}s"
            ) from exc


def run_edge_tts_mp3_save(text, out_path, rate: str) -> None:
    from omnivoice_tts import ensure_tts_trailing_period

    tts_text = ensure_tts_trailing_period(text)
    asyncio.run(edge_tts_save_mp3_async(tts_text, out_path, rate))
