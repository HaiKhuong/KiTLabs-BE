from __future__ import annotations

import asyncio
import logging
import subprocess
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.tts")


def synthesize_segments(
    narrations: list[str],
    out_dir: Path,
    engine: str = "edge",
    voice: str = "vi-VN-HoaiMyNeural",
) -> list[dict[str, Any]]:
    out_dir.mkdir(parents=True, exist_ok=True)
    meta: list[dict[str, Any]] = []
    for i, text in enumerate(narrations):
        wav = out_dir / f"seg_{i:03d}.wav"
        mp3 = out_dir / f"seg_{i:03d}.mp3"
        if engine == "edge":
            _edge_tts(text, mp3, voice=voice)
            _to_wav(mp3, wav)
        else:
            # fallback edge
            _edge_tts(text, mp3, voice=voice)
            _to_wav(mp3, wav)
        dur = _probe_duration(wav)
        meta.append({"i": i, "file": str(wav), "audioDur": dur, "text": text})
        LOG.info("TTS seg %d dur=%.2fs", i, dur)
    return meta


def _edge_tts(text: str, out_mp3: Path, voice: str) -> None:
    try:
        import edge_tts  # type: ignore
    except Exception as exc:
        raise RuntimeError(
            "edge-tts is required for recap TTS. pip install edge-tts"
        ) from exc

    async def _run() -> None:
        communicate = edge_tts.Communicate(text=text or ".", voice=voice)
        await communicate.save(str(out_mp3))

    asyncio.run(_run())


def _to_wav(src: Path, dst: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "44100",
        str(dst),
    ]
    subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _probe_duration(path: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    return float(subprocess.check_output(cmd, text=True).strip())
