"""
Ghép các file voice theo thứ tự scene, chèn gap cố định giữa mỗi đoạn.

Stdin JSON:
  out_wav: str
  sample_rate?: int (default 24000)
  gap_sec?: float (default 0.2)
  segments: [{ wav, scene_number }]

Stdout JSON:
  { ok: true, duration_sec: number }
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

FFMPEG_BIN = (os.getenv("FFMPEG_BIN") or "ffmpeg").strip() or "ffmpeg"
FFPROBE_BIN = (os.getenv("FFPROBE_BIN") or "ffprobe").strip() or "ffprobe"
SAMPLE_RATE = 24000
DEFAULT_GAP_SEC = 0.2


def _run_ffmpeg(args: list[str], label: str) -> None:
    cmd = [FFMPEG_BIN, "-y", *args]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{label} failed: {err[:2000]}")


def _probe_duration_sec(path: Path) -> float:
    proc = subprocess.run(
        [
            FFPROBE_BIN,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        return 0.0
    try:
        return max(0.0, float((proc.stdout or "").strip()))
    except ValueError:
        return 0.0


def _write_silence(out_path: Path, duration_sec: float, sample_rate: int) -> None:
    dur = max(0.0, float(duration_sec))
    if dur <= 0.001:
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
            str(out_path),
        ],
        "Create silence",
    )


def _concat_wavs(paths: list[Path], out_wav: Path) -> None:
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
        "Concat merged voice",
    )
    try:
        list_file.unlink(missing_ok=True)
    except OSError:
        pass


def merge_voice_timeline(payload: dict[str, Any]) -> dict[str, Any]:
    out_wav = Path(str(payload["out_wav"]))
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = int(payload.get("sample_rate") or SAMPLE_RATE)
    gap_sec = float(payload.get("gap_sec") or payload.get("gapSec") or DEFAULT_GAP_SEC)
    gap_sec = max(0.0, gap_sec)

    raw_segments = payload.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raise ValueError("segments must be a non-empty array")

    parsed: list[dict[str, Any]] = []
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        wav = Path(str(item.get("wav") or item.get("out_wav") or "")).expanduser()
        if not wav.is_file():
            continue
        parsed.append(
            {
                "wav": wav,
                "scene_number": int(item.get("scene_number") or item.get("sceneNumber") or 0),
            }
        )

    if not parsed:
        raise ValueError("No valid wav segments to merge")

    parsed.sort(key=lambda row: row["scene_number"])

    timeline: list[Path] = []

    with tempfile.TemporaryDirectory(prefix="voice_merge_") as tmp:
        tmp_dir = Path(tmp)

        for i, row in enumerate(parsed):
            timeline.append(row["wav"])
            if i < len(parsed) - 1 and gap_sec > 0.001:
                gap_path = tmp_dir / f"gap_{i:04d}.wav"
                _write_silence(gap_path, gap_sec, sample_rate)
                timeline.append(gap_path)

        _concat_wavs(timeline, out_wav)

    duration_sec = _probe_duration_sec(out_wav)
    return {"ok": True, "duration_sec": duration_sec}


def main() -> None:
    payload = json.load(sys.stdin)
    result = merge_voice_timeline(payload)
    json.dump(result, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
