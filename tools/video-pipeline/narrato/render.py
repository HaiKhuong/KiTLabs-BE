"""Narrato Film render — same pipeline as NarratoAI task.start_subclip_unified:

1. TTS for OST=0/2
2. clip_video_unified (OST=0 silent by TTS length; OST=1 timestamp + source audio)
3. audio_merger overlay TTS on duration timeline
4. merger_video.combine_clip_videos (normalize 30fps, concat video, delay-mix OST>0 audio)
5. generate_video.merge_materials (mix TTS track onto combined video)
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from asr import has_audio_stream, parse_timestamp_range
from audio_merger import merge_audio_files
from clip_video import clip_video_unified
from merger_video import combine_clip_videos, merge_materials
from script import is_orig_narration
from tts import synthesize_clip

LOG = logging.getLogger("narrato.render")


def _ffmpeg() -> str:
    return (os.environ.get("FFMPEG_BIN") or os.environ.get("FFMPEG_PATH") or "ffmpeg").strip() or "ffmpeg"


def _ffprobe() -> str:
    explicit = (os.environ.get("FFPROBE_BIN") or "").strip()
    if explicit:
        return explicit
    fb = Path(_ffmpeg())
    for name in ("ffprobe.exe", "ffprobe"):
        cand = fb.with_name(name)
        if cand.exists():
            return str(cand)
    return "ffprobe"


def _run(cmd: list[str], timeout: int = 7200) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2500:]
        raise RuntimeError(f"ffmpeg failed: {tail}")


def probe_duration(path: Path) -> float:
    cmd = [
        _ffprobe(),
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(path),
    ]
    try:
        out = subprocess.check_output(cmd, text=True, timeout=60).strip()
        dur = float(out)
        if dur > 0:
            return dur
    except (subprocess.CalledProcessError, ValueError, subprocess.TimeoutExpired, OSError) as exc:
        LOG.warning("ffprobe duration failed for %s (%s)", path, exc)
    raise RuntimeError(f"Cannot read duration: {path}")


def probe_video_size(path: Path) -> tuple[int, int]:
    cmd = [
        _ffprobe(),
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0",
        str(path),
    ]
    out = subprocess.check_output(cmd, text=True, timeout=60).strip()
    parts = [p for p in out.replace(";", ",").split(",") if p.strip()]
    width, height = int(parts[0]), int(parts[1])
    return max(width - width % 2, 2), max(height - height % 2, 2)


def ost0_clip_duration(tts_duration: float, timestamp_duration: float) -> float:
    del timestamp_duration
    return max(float(tts_duration or 0), 0.04)


def render_items(
    video: Path,
    items: list[dict[str, Any]],
    work_dir: Path,
    out_mp4: Path,
    *,
    voice: str = "vi-VN-HoaiMyNeural",
    rate: str = "+0%",
    tts_engine: str = "edge",
    ref_audio: str | None = None,
    ref_text: str | None = None,
    tts_language: str | None = None,
) -> Path:
    ff = _ffmpeg()
    clips_dir = work_dir / "clips"
    tts_dir = work_dir / "tts"
    clips_dir.mkdir(parents=True, exist_ok=True)
    tts_dir.mkdir(parents=True, exist_ok=True)

    tts_map: dict[int, dict[str, Any]] = {}
    for item in items:
        ost = int(item.get("OST") or 0)
        item_id = int(item["_id"])
        if ost not in (0, 2):
            continue
        narration = str(item.get("narration") or "").strip()
        if not narration or is_orig_narration(narration, item_id):
            continue
        wav = tts_dir / f"tts_{item_id:04d}.wav"
        ok = synthesize_clip(
            narration,
            wav,
            engine=tts_engine,
            voice=voice,
            rate=rate,
            ref_audio=ref_audio,
            ref_text=ref_text,
            language=tts_language,
        )
        if not ok:
            raise RuntimeError(f"TTS failed for OST=0 item {item_id}")
        tts_map[item_id] = {"_id": item_id, "audio_file": wav, "duration": probe_duration(wav)}

    LOG.info("[render] clip_video_unified — %s items", len(items))
    video_result = clip_video_unified(video, items, tts_map, clips_dir, ff, _run)

    list_script: list[dict[str, Any]] = []
    video_paths: list[Path] = []
    video_ost: list[int] = []
    for item in items:
        item_id = int(item["_id"])
        ost = int(item.get("OST") or 0)
        clip = video_result[item_id]
        duration = probe_duration(clip)
        start, end = parse_timestamp_range(str(item["timestamp"]))
        LOG.info(
            "id=%s OST=%s timestamp=%.2fs clip=%.2fs tts=%s",
            item_id,
            ost,
            max(end - start, 0),
            duration,
            f"{tts_map[item_id]['duration']:.2f}s" if item_id in tts_map else "-",
        )
        audio_path = ""
        if item_id in tts_map:
            audio_path = str(tts_map[item_id]["audio_file"])
        list_script.append({**item, "duration": duration, "audio": audio_path, "video": str(clip)})
        video_paths.append(clip)
        video_ost.append(ost)

    LOG.info("[render] merge_audio_files (TTS timeline)")
    merged_tts = merge_audio_files(list_script, work_dir / "merger_audio.aac", ff, _run, probe_duration)

    width, height = probe_video_size(video)
    merger_mp4 = work_dir / "merger.mp4"
    LOG.info("[render] combine_clip_videos %sx%s", width, height)
    combine_clip_videos(
        merger_mp4,
        video_paths,
        video_ost,
        ff,
        _run,
        probe_duration,
        width,
        height,
    )

    has_ost1 = any(int(item.get("OST") or 0) == 1 for item in items)
    original_volume = 1.0 if has_ost1 else 0.7
    keep_original = has_audio_stream(merger_mp4)
    LOG.info("[render] merge_materials keep_original=%s orig_vol=%s", keep_original, original_volume)
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    merge_materials(
        merger_mp4,
        merged_tts,
        out_mp4,
        ff,
        _run,
        probe_duration,
        voice_volume=1.0,
        original_audio_volume=original_volume if keep_original else 0.0,
        keep_original_audio=keep_original,
    )
    if not out_mp4.exists():
        raise RuntimeError("Render finished but output missing")
    return out_mp4
