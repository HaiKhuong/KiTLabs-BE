"""
SRT → OmniVoice timeline WAV: TTS từng cue, chèn silence gap theo start time SRT, concat full audio.

Stdin JSON:
  srt_text | srt_path: str
  out_wav: str
  ref_audio, ref_text, model_id, device_map, dtype_str, language
  num_step?, guidance_scale?, seed?
  playback_speed?: float (atempo after each cue TTS, default 1)
  fit_to_cue?: bool (default true) — nếu dài hơn cửa sổ cue thì atempo cho vừa
  sample_rate?: int (default 24000)

Stdout JSON: { ok, duration_sec, cue_count, gap_count }
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pipeline_cache  # noqa: F401
from omnivoice_tts import prepare_omnivoice_input_text, resolve_omnivoice_language, synthesize_to_wav

FFMPEG_BIN = (os.getenv("FFMPEG_BIN") or "ffmpeg").strip() or "ffmpeg"
FFPROBE_BIN = (os.getenv("FFPROBE_BIN") or "ffprobe").strip() or "ffprobe"
SAMPLE_RATE = 24000


def _run_ffmpeg(args: list[str], label: str) -> None:
    proc = subprocess.run([FFMPEG_BIN, "-y", *args], capture_output=True, text=True)
    if proc.returncode != 0:
        err = (proc.stderr or proc.stdout or "").strip()
        raise RuntimeError(f"{label} failed: {err[:2000]}")


def _probe_duration_sec(path: Path) -> float:
    proc = subprocess.run(
        [
            FFPROBE_BIN, "-v", "error",
            "-show_entries", "format=duration",
            "-of", "default=noprint_wrappers=1:nokey=1",
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
        # tiny placeholder so concat list stays valid if needed
        dur = 0.02
    _run_ffmpeg(
        [
            "-f", "lavfi",
            "-i", f"anullsrc=r={sample_rate}:cl=mono",
            "-t", f"{dur:.3f}",
            "-acodec", "pcm_s16le",
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
    try:
        _run_ffmpeg(
            ["-f", "concat", "-safe", "0", "-i", str(list_file), "-c", "copy", str(out_wav)],
            "Concat SRT timeline",
        )
    finally:
        try:
            list_file.unlink(missing_ok=True)
        except OSError:
            pass


def _atempo_chain(speed: float) -> str:
    """Build ffmpeg atempo filter chain (each atempo in 0.5..2.0)."""
    s = max(0.5, min(2.0, float(speed)))
    filters: list[str] = []
    remaining = s
    while remaining > 2.0 + 1e-9:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5 - 1e-9:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def _apply_speed(src: Path, dst: Path, speed: float) -> None:
    if abs(speed - 1.0) < 1e-6:
        import shutil
        shutil.copy2(src, dst)
        return
    _run_ffmpeg(
        ["-i", str(src), "-af", _atempo_chain(speed), "-acodec", "pcm_s16le", str(dst)],
        "Apply playback speed",
    )


def _fit_to_duration(src: Path, dst: Path, target_sec: float, sample_rate: int) -> None:
    """Speed up (or pad) so output ≈ target_sec."""
    dur = _probe_duration_sec(src)
    if dur <= 0.01:
        _write_silence(dst, max(0.02, target_sec), sample_rate)
        return
    target = max(0.05, float(target_sec))
    if dur <= target + 0.02:
        # Pad trailing silence to fill cue window
        if target - dur > 0.02:
            pad = src.parent / f"_pad_{src.stem}.wav"
            _write_silence(pad, target - dur, sample_rate)
            _concat_wavs([src, pad], dst)
            try:
                pad.unlink(missing_ok=True)
            except OSError:
                pass
        else:
            import shutil
            shutil.copy2(src, dst)
        return
    speed = min(2.0, max(1.0, dur / target))
    _apply_speed(src, dst, speed)


_TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


def _ts_to_ms(h: str, m: str, s: str, ms: str) -> int:
    frac = (ms + "000")[:3]
    return (
        int(h) * 3_600_000
        + int(m) * 60_000
        + int(s) * 1_000
        + int(frac)
    )


def parse_srt(text: str) -> list[dict[str, Any]]:
    raw = (text or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    if not raw:
        return []
    blocks: list[dict[str, Any]] = []
    chunks = re.split(r"\n\s*\n", raw)
    for chunk in chunks:
        lines = [ln.strip() for ln in chunk.split("\n") if ln.strip() != ""]
        if len(lines) < 2:
            continue
        # Optional index line
        time_line_idx = 0
        if re.fullmatch(r"\d+", lines[0]):
            time_line_idx = 1
        if time_line_idx >= len(lines):
            continue
        m = _TIME_RE.search(lines[time_line_idx])
        if not m:
            continue
        start_ms = _ts_to_ms(m.group(1), m.group(2), m.group(3), m.group(4))
        end_ms = _ts_to_ms(m.group(5), m.group(6), m.group(7), m.group(8))
        if end_ms <= start_ms:
            continue
        body = " ".join(lines[time_line_idx + 1 :]).strip()
        body = re.sub(r"<[^>]+>", "", body)
        blocks.append({"start_ms": start_ms, "end_ms": end_ms, "text": body})
    blocks.sort(key=lambda b: b["start_ms"])
    return blocks


def run_srt_timeline(payload: dict[str, Any]) -> dict[str, Any]:
    out_wav = Path(str(payload["out_wav"]))
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = int(payload.get("sample_rate") or SAMPLE_RATE)
    fit_to_cue = bool(payload.get("fit_to_cue", True))
    playback_speed = float(payload.get("playback_speed") or payload.get("speed") or 1.0)
    playback_speed = max(0.5, min(2.0, playback_speed))

    srt_text = str(payload.get("srt_text") or "").strip()
    if not srt_text:
        srt_path = Path(str(payload.get("srt_path") or "")).expanduser()
        if not srt_path.is_file():
            raise ValueError("srt_text or srt_path is required")
        srt_text = srt_path.read_text(encoding="utf-8")

    cues = parse_srt(srt_text)
    if not cues:
        raise ValueError("SRT has no valid cues")
    if not any(str(c.get("text") or "").strip() for c in cues):
        raise ValueError("SRT has no speakable text")

    ref_audio = Path(str(payload["ref_audio"])).expanduser()
    if not ref_audio.is_file():
        raise FileNotFoundError(f"ref_audio not found: {ref_audio}")
    ref_text = str(payload.get("ref_text") or "")
    model_id = str(payload.get("model_id") or "k2-fsa/OmniVoice").strip()
    device_map = str(payload.get("device_map") or "cpu").strip() or "cpu"
    dtype_str = str(payload.get("dtype_str") or "float16").strip() or "float16"
    language = resolve_omnivoice_language(str(payload.get("language") or "vietnamese"))
    num_step = payload.get("num_step")
    guidance_scale = payload.get("guidance_scale")
    seed = payload.get("seed")

    gap_count = 0
    speak_count = 0
    timeline: list[Path] = []
    current_ms = 0

    with tempfile.TemporaryDirectory(prefix="srt_tts_") as tmp:
        tmp_dir = Path(tmp)

        for i, cue in enumerate(cues):
            start_ms = int(cue["start_ms"])
            end_ms = int(cue["end_ms"])
            text = prepare_omnivoice_input_text(str(cue.get("text") or ""))
            cue_dur_sec = max(0.05, (end_ms - start_ms) / 1000.0)

            if start_ms > current_ms:
                gap_sec = (start_ms - current_ms) / 1000.0
                gap_path = tmp_dir / f"gap_{i:04d}.wav"
                _write_silence(gap_path, gap_sec, sample_rate)
                timeline.append(gap_path)
                gap_count += 1
                current_ms = start_ms

            if not text:
                empty_path = tmp_dir / f"empty_{i:04d}.wav"
                _write_silence(empty_path, cue_dur_sec, sample_rate)
                timeline.append(empty_path)
                current_ms = end_ms
                continue

            raw_path = tmp_dir / f"raw_{i:04d}.wav"
            synthesize_to_wav(
                text=text,
                out_wav=raw_path,
                ref_audio=str(ref_audio),
                ref_text=ref_text,
                model_id=model_id,
                device_map=device_map,
                dtype_str=dtype_str,
                language=language,
                num_step=int(num_step) if num_step not in (None, "") else None,
                guidance_scale=float(guidance_scale) if guidance_scale not in (None, "") else None,
                seed=int(seed) if seed not in (None, "") else None,
            )

            sped = tmp_dir / f"sped_{i:04d}.wav"
            _apply_speed(raw_path, sped, playback_speed)

            final_seg = tmp_dir / f"part_{i:04d}.wav"
            if fit_to_cue:
                _fit_to_duration(sped, final_seg, cue_dur_sec, sample_rate)
            else:
                import shutil
                shutil.copy2(sped, final_seg)

            timeline.append(final_seg)
            speak_count += 1
            seg_ms = int(round(_probe_duration_sec(final_seg) * 1000))
            current_ms = start_ms + max(seg_ms, 1)

        _concat_wavs(timeline, out_wav)

    return {
        "ok": True,
        "duration_sec": _probe_duration_sec(out_wav),
        "cue_count": len(cues),
        "speak_count": speak_count,
        "gap_count": gap_count,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("stdin must be a JSON object")
        result = run_srt_timeline(payload)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
