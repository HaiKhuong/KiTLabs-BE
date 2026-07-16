"""Movie recap pipeline — ASR, scenes, Gemini A/B, TTS, voice-master pack, FFmpeg."""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

from asr import run_asr, merge_transcript_windows, format_transcript_timestamped
from cluster import cluster_semantic_scenes, shortlist_shots
from gemini_recap import (
    PICKS_SELECTED_SHOTS,
    SCRIPT_DURATION_SEC,
    SCRIPT_MOVIE_WINDOWS,
    SCRIPT_NARRATIONS,
    SCRIPT_RECAP_TIMELINE,
    canonicalize_script,
    generate_script,
    pick_shots,
    validate_script,
)
from render import render_timeline
from scenes import detect_shots
from timeline import pack_voice_master_timeline
from tts import synthesize_segments

LOG = logging.getLogger("recap")

# High-level pipeline steps (shown in FE runtime log / pipeline.log)
TOTAL_STEPS = 8


def step_start(n: int, name: str, detail: str = "") -> None:
    msg = f"[STEP {n}/{TOTAL_STEPS}] {name}"
    if detail:
        msg = f"{msg} — {detail}"
    LOG.info(msg)


def step_done(n: int, name: str, detail: str = "") -> None:
    msg = f"[STEP {n}/{TOTAL_STEPS}] {name} done"
    if detail:
        msg = f"{msg} — {detail}"
    LOG.info(msg)


def setup_logging(work_dir: Path) -> None:
    log_dir = work_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "pipeline.log"
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler(sys.stdout)
    sh.setFormatter(fmt)
    root.handlers.clear()
    root.addHandler(fh)
    root.addHandler(sh)


def load_config(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def probe_duration(video: Path) -> float:
    cmd = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(video),
    ]
    out = subprocess.check_output(cmd, text=True).strip()
    return float(out)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def default_beats(total_max: int) -> list[list[Any]]:
    """Recap timeline beat grid (seconds)."""
    t = float(total_max)
    return [
        ["hook", 0, int(t * 0.05)],
        ["setup", int(t * 0.05), int(t * 0.25)],
        ["rising", int(t * 0.25), int(t * 0.60)],
        ["climax", int(t * 0.60), int(t * 0.85)],
        ["ending", int(t * 0.85), int(t * 0.95)],
        ["outro", int(t * 0.95), int(t)],
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="KiTLabs movie recap pipeline")
    parser.add_argument("--video", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    video = Path(args.video).resolve()
    work_dir = Path(args.work_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(work_dir)

    try:
        if not video.exists():
            raise FileNotFoundError(f"Video not found: {video}")

        cfg = load_config(Path(args.config))
        title = str(cfg.get("title") or cfg.get("displayName") or video.stem)
        dur_min = int(cfg.get("durationMinSec") or 900)
        dur_max = int(cfg.get("durationMaxSec") or 1200)
        wpm = int(cfg.get("wordsPerMinute") or 140)
        locale = str(cfg.get("locale") or "vi")
        year = cfg.get("year")
        movie_dur = probe_duration(video)
        LOG.info(
            "Recap start title=%s source=%.0fs target=%d–%ds work=%s",
            title,
            movie_dur,
            dur_min,
            dur_max,
            work_dir,
        )

        # 1) ASR
        step_start(1, "ASR", "Whisper transcript")
        transcript_path = work_dir / "transcript.json"
        if transcript_path.exists():
            transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
            step_done(1, "ASR", f"cache hit ({len(transcript.get('segments', []))} segs)")
        else:
            transcript = run_asr(video, work_dir)
            write_json(transcript_path, transcript)
            step_done(1, "ASR", f"{len(transcript.get('segments', []))} segs")
        tr_merged = merge_transcript_windows(transcript.get("segments", []), window_sec=30.0)
        transcript_text = format_transcript_timestamped(transcript.get("segments", []))

        # 2) Shots (TransNet V2 or fallback)
        step_start(2, "Scenes", "shot detect (TransNet / FFmpeg)")
        shots_path = work_dir / "shots.json"
        if shots_path.exists():
            shots = json.loads(shots_path.read_text(encoding="utf-8"))
            step_done(2, "Scenes", f"cache hit ({len(shots)} shots)")
        else:
            shots = detect_shots(video, work_dir, movie_dur)
            write_json(shots_path, shots)
            step_done(2, "Scenes", f"{len(shots)} shots")

        # 3) Semantic cluster + embeddings for rank
        step_start(3, "Cluster", "OpenCLIP semantic scenes")
        scenes_path = work_dir / "semantic_scenes.json"
        if scenes_path.exists():
            semantic = json.loads(scenes_path.read_text(encoding="utf-8"))
            step_done(3, "Cluster", f"cache hit ({len(semantic.get('scenes', []))} scenes)")
        else:
            semantic = cluster_semantic_scenes(video, shots, work_dir)
            write_json(scenes_path, semantic)
            step_done(3, "Cluster", f"{len(semantic.get('scenes', []))} scenes")

        # 4) Gemini A — script
        step_start(4, "Gemini A", "write recap script")
        script_path = work_dir / "script.json"
        gemini_model = str(cfg.get("geminiModel") or "")
        gemini_tier = str(cfg.get("geminiKeyTier") or cfg.get("gemini_key_tier") or "")
        if script_path.exists() and cfg.get("reuseScript"):
            script = json.loads(script_path.read_text(encoding="utf-8"))
            step_done(4, "Gemini A", "reuse script.json")
        else:
            payload_a = {
                "task": "recap_script",
                "language": locale,
                "wordsPerMinute": wpm,
                "movie": {
                    "title": title,
                    "year": year,
                    "durationSec": int(movie_dur),
                },
                "recapTarget": {
                    "totalDurationRange": [dur_min, dur_max],
                    "segmentDurationRange": [15, 40],
                    "storyBeats": default_beats(dur_max),
                },
                "transcript": transcript_text,
                "transcriptSummary": tr_merged,
            }
            script = generate_script(payload_a, model=gemini_model, key_tier=gemini_tier)
            script = canonicalize_script(script, payload_a)
            validate_script(script, dur_min=dur_min, dur_max=dur_max, movie_dur=movie_dur, wpm=wpm)
            write_json(script_path, script)
            step_done(
                4,
                "Gemini A",
                f"{len(script.get(SCRIPT_NARRATIONS, []))} segs · {script.get(SCRIPT_DURATION_SEC)}s",
            )

        # 5) Local shortlist + Gemini B
        step_start(5, "Gemini B", "pick shots per segment")
        script = canonicalize_script(script)
        narrations = script[SCRIPT_NARRATIONS]
        ranges_m = script[SCRIPT_MOVIE_WINDOWS]
        ranges_r = script[SCRIPT_RECAP_TIMELINE]
        need = [max(1.0, float(r[1]) - float(r[0])) for r in ranges_r]
        transcript_segments = transcript.get("segments") or []
        candidate_segments: list[list[dict[str, Any]]] = []
        pick_segments: list[dict[str, Any]] = []
        used: set[int] = set()
        for i, m in enumerate(ranges_m):
            c = shortlist_shots(
                shots=shots,
                semantic=semantic,
                movie_range=(float(m[0]), float(m[1])),
                need_sec=need[i],
                limit=24,
                exclude=used,
                transcript_segments=transcript_segments,
            )
            candidate_segments.append(c)
            pick_segments.append(
                {
                    "segmentIndex": i,
                    "narration": narrations[i],
                    "durationSec": int(round(need[i])),
                    "candidates": c,
                }
            )
            used.update(item["id"] for item in c[:3])

        picks_path = work_dir / "picks.json"
        picks = pick_shots(
            {"task": "pick_shots", "segments": pick_segments},
            model=gemini_model,
            key_tier=gemini_tier,
        )
        # Sanitize: only ids in shortlist; fallback fill
        sanitized: list[list[int]] = []
        selected = picks.get(PICKS_SELECTED_SHOTS) or picks.get("s") or []
        for i, chosen in enumerate(selected):
            allow = {c["id"] for c in candidate_segments[i]}
            row = [int(x) for x in chosen if int(x) in allow]
            if not row:
                row = [c["id"] for c in candidate_segments[i][: max(1, int(need[i] / 3))]]
            sanitized.append(row)
        while len(sanitized) < len(narrations):
            i = len(sanitized)
            sanitized.append(
                [c["id"] for c in candidate_segments[i][: max(1, int(need[i] / 3))]]
            )
        picks = {PICKS_SELECTED_SHOTS: sanitized}
        write_json(picks_path, picks)
        step_done(5, "Gemini B", f"{len(sanitized)} segments picked")

        # 6) TTS + measure audioDur
        step_start(6, "TTS", f"{len(narrations)} narrations")
        audio_dir = work_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        tts_meta = synthesize_segments(
            narrations=narrations,
            out_dir=audio_dir,
            engine=str(cfg.get("ttsEngine") or "edge"),
            voice=str(cfg.get("edgeTtsVoice") or "vi-VN-HoaiMyNeural"),
        )
        write_json(work_dir / "tts.json", tts_meta)
        step_done(6, "TTS", f"{len(tts_meta)} audio files")

        # 7) Voice-master pack
        step_start(7, "Timeline", "voice-master pack")
        timeline = pack_voice_master_timeline(
            shots=shots,
            picks=sanitized,
            candidates=[[c["id"] for c in seg] for seg in candidate_segments],
            tts_meta=tts_meta,
        )
        write_json(work_dir / "timeline.json", timeline)
        step_done(7, "Timeline", f"{timeline.get('durationSec')}s")

        # 8) Render
        step_start(8, "Render", "FFmpeg mux")
        out_dir = work_dir / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_mp4 = out_dir / "recap.mp4"
        render_timeline(video=video, timeline=timeline, out_mp4=out_mp4, work_dir=work_dir)
        if not out_mp4.exists():
            raise RuntimeError("Render finished but output missing")
        step_done(8, "Render", str(out_mp4))

        print(f"DONE: {out_mp4}", flush=True)
        LOG.info("DONE %s", out_mp4)
        return 0
    except Exception as exc:
        msg = str(exc)
        LOG.error("[RECAP_FAILED] %s\n%s", msg, traceback.format_exc())
        print(f"[RECAP_FAILED] {msg}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Allow running as script from recap/ directory
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    raise SystemExit(main())
