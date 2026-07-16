"""Movie recap pipeline v2 — ASR, scenes, CallA-1/A-2, TTS, CallB, voice-master pack, FFmpeg."""

from __future__ import annotations

import argparse
import json
import logging
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

# Flush immediately so Nest sees progress before heavy work / possible hangs.
print(f"[RECAP] boot python={sys.executable}", flush=True)

from asr import run_asr, merge_transcript_windows, format_transcript_timestamped
from call_a1_story_analyst import (
    attach_candidate_shots,
    build_a1_payload,
    generate_story_knowledge,
)
from call_a2_script_writer import (
    derive_script_from_segments,
    generate_narration_segments,
    merged_candidates_for_segment,
)
from call_b_shot_planner import plan_all_segments
from cluster import cluster_semantic_scenes
from gemini_recap import (
    PICKS_SELECTED_SHOTS,
    SCRIPT_DURATION_SEC,
    SCRIPT_NARRATIONS,
    canonicalize_script,
    validate_script,
)
from render import render_timeline
from scenes import detect_shots
from timeline import pack_voice_master_timeline
from tts import format_edge_rate, synthesize_segments

print("[RECAP] boot modules loaded", flush=True)

LOG = logging.getLogger("recap")

# High-level pipeline steps (shown in FE runtime log / pipeline.log)
TOTAL_STEPS = 9


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
    out = subprocess.check_output(cmd, text=True, timeout=120).strip()
    return float(out)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def cleanup_work_artifacts(work_dir: Path, keep_debug: bool) -> None:
    """When keep_debug=False, remove heavy intermediates after successful render."""
    if keep_debug:
        LOG.info("keepDebugArtifacts=true — retaining work-dir intermediates")
        return
    heavy = [
        work_dir / "clips",
        work_dir / "keyframes",
        work_dir / "audio",
        work_dir / "debug",
        work_dir / "video_only.mp4",
        work_dir / "voice_mix.wav",
        work_dir / "concat_video.txt",
        work_dir / "concat_voice.txt",
        work_dir / ".mplconfig",
        work_dir / ".cache",
        work_dir / "audio_16k.wav",
    ]
    for p in heavy:
        try:
            if p.is_dir():
                shutil.rmtree(p, ignore_errors=True)
            elif p.is_file():
                p.unlink(missing_ok=True)
        except Exception as exc:
            LOG.warning("cleanup skip %s: %s", p, exc)
    LOG.info("keepDebugArtifacts=false — cleaned heavy intermediates (kept json + output)")


def write_debug_index(debug_dir: Path, work_dir: Path) -> None:
    lines = [
        "Recap debug artifacts (pipeline v2)",
        "===================================",
        "",
        "Work dir layout:",
        f"  {work_dir}",
        "",
        "JSON manifests:",
        "  transcript.json          — Whisper ASR",
        "  shots.json               — shot boundaries (TransNet / FFmpeg)",
        "  semantic_scenes.json     — CLIP-clustered scenes",
        "  story_knowledge.json     — CallA-1 characters / acts / events",
        "  segments.json            — CallA-2 narrations + visualBeats",
        "  script.json              — Nest/FE flat script (derived from A-2)",
        "  candidates.json          — merged candidate shots per segment",
        "  picks.json               — CallB selected shot ids per segment",
        "  tts.json                 — TTS segment meta + durations",
        "  timeline.json            — voice-master cues",
        "",
        "Folders:",
        "  keyframes/               — mid-frame JPG per shot (CLIP)",
        "  clips/                   — cut B-roll segments used in render",
        "  audio/                   — TTS wav/mp3 per narration",
        "  output/recap.mp4         — final mux",
        "  logs/pipeline.log",
        "",
        "Gemini dumps (this folder):",
        "  gemini_a1_request.json / gemini_a1_response.json / gemini_a1_response_raw.txt",
        "  gemini_a2_request.json / gemini_a2_response.json / gemini_a2_response_raw.txt",
        "  gemini_*_prompt.txt      — full prompt sent to model",
        "",
    ]
    debug_dir.mkdir(parents=True, exist_ok=True)
    (debug_dir / "README.txt").write_text("\n".join(lines), encoding="utf-8")


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
    LOG.info("[RECAP] logging ready work=%s", work_dir)

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
        keep_debug = bool(cfg.get("keepDebugArtifacts", True))
        debug_dir = work_dir / "debug"
        if keep_debug:
            write_debug_index(debug_dir, work_dir)
        LOG.info("[RECAP] probing duration video=%s", video)
        movie_dur = probe_duration(video)
        LOG.info(
            "Recap start title=%s source=%.0fs target=%d–%ds keepDebug=%s work=%s",
            title,
            movie_dur,
            dur_min,
            dur_max,
            keep_debug,
            work_dir,
        )

        gemini_model = str(cfg.get("geminiModel") or "")
        gemini_tier = str(cfg.get("geminiKeyTier") or cfg.get("gemini_key_tier") or "")

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
        transcript_segments = transcript.get("segments") or []

        # 2) Shots
        step_start(2, "Scenes", "shot detect (TransNet / FFmpeg)")
        shots_path = work_dir / "shots.json"
        if shots_path.exists():
            shots = json.loads(shots_path.read_text(encoding="utf-8"))
            step_done(2, "Scenes", f"cache hit ({len(shots)} shots)")
        else:
            shots = detect_shots(video, work_dir, movie_dur)
            write_json(shots_path, shots)
            step_done(2, "Scenes", f"{len(shots)} shots")

        # 3) Semantic cluster
        step_start(3, "Cluster", "OpenCLIP semantic scenes")
        scenes_path = work_dir / "semantic_scenes.json"
        if scenes_path.exists():
            semantic = json.loads(scenes_path.read_text(encoding="utf-8"))
            step_done(3, "Cluster", f"cache hit ({len(semantic.get('scenes', []))} scenes)")
        else:
            semantic = cluster_semantic_scenes(video, shots, work_dir)
            write_json(scenes_path, semantic)
            step_done(3, "Cluster", f"{len(semantic.get('scenes', []))} scenes")

        # 4) CallA-1 — story knowledge
        step_start(4, "CallA-1", "story analyst")
        knowledge_path = work_dir / "story_knowledge.json"
        if knowledge_path.exists() and cfg.get("reuseScript"):
            knowledge = json.loads(knowledge_path.read_text(encoding="utf-8"))
            step_done(4, "CallA-1", "reuse story_knowledge.json")
        else:
            payload_a1 = build_a1_payload(
                movie_title=title,
                movie_duration=movie_dur,
                transcript=transcript_text,
            )
            # optional metadata for debug context (model instructed to ignore shots)
            payload_a1["year"] = year
            knowledge = generate_story_knowledge(
                payload_a1,
                model=gemini_model,
                key_tier=gemini_tier,
                debug_dir=debug_dir if keep_debug else None,
                movie_title=title,
                movie_dur=movie_dur,
                transcript_summary=tr_merged,
                semantic=semantic,
            )
            write_json(knowledge_path, knowledge)
            step_done(
                4,
                "CallA-1",
                f"{len(knowledge.get('events', []))} events · {len(knowledge.get('characters', []))} chars",
            )

        # 5) Attach candidate shots per event
        step_start(5, "Candidates", "attach shots per event window")
        knowledge = attach_candidate_shots(
            knowledge,
            shots=shots,
            semantic=semantic,
            transcript_segments=transcript_segments,
        )
        write_json(knowledge_path, knowledge)
        n_cands = sum(len(e.get("candidate_shots") or []) for e in knowledge.get("events") or [])
        step_done(5, "Candidates", f"{n_cands} candidate links")

        # 6) CallA-2 — segments + derive Nest script.json
        step_start(6, "CallA-2", "script writer + visual beats")
        script_path = work_dir / "script.json"
        segments_path = work_dir / "segments.json"
        if script_path.exists() and segments_path.exists() and cfg.get("reuseScript"):
            segments = json.loads(segments_path.read_text(encoding="utf-8"))
            if isinstance(segments, dict):
                segments = segments.get("segments") or []
            script = json.loads(script_path.read_text(encoding="utf-8"))
            step_done(6, "CallA-2", "reuse segments.json / script.json")
        else:
            segments = generate_narration_segments(
                knowledge,
                locale=locale,
                dur_min=dur_min,
                dur_max=dur_max,
                model=gemini_model,
                key_tier=gemini_tier,
                debug_dir=debug_dir if keep_debug else None,
            )
            write_json(segments_path, {"segments": segments})
            script = derive_script_from_segments(segments, knowledge, movie_dur=movie_dur)
            script = canonicalize_script(script)
            validate_script(script, dur_min=dur_min, dur_max=dur_max, movie_dur=movie_dur, wpm=wpm)
            write_json(script_path, script)
            # persist eventIds back onto segments after mapping
            write_json(segments_path, {"segments": segments})
            step_done(
                6,
                "CallA-2",
                f"{len(segments)} segments · {script.get(SCRIPT_DURATION_SEC)}s",
            )

        narrations = script[SCRIPT_NARRATIONS]
        if len(segments) != len(narrations):
            # keep segments aligned to script narrations if canonicalize trimmed
            if len(segments) > len(narrations):
                segments = segments[: len(narrations)]
            LOG.info("segments=%d narrations=%d", len(segments), len(narrations))

        # Build per-segment candidate pools for CallB / timeline
        segment_candidates: list[list[dict[str, Any]]] = []
        pick_debug: list[dict[str, Any]] = []
        for i, seg in enumerate(segments):
            cands = merged_candidates_for_segment(seg, knowledge)
            # normalize to timeline-friendly shape
            rich = [
                {
                    "id": int(c.get("id", c.get("shot_id"))),
                    "startSec": c.get("startSec"),
                    "endSec": c.get("endSec"),
                    "durationSec": c.get("durationSec"),
                    "subtitle": c.get("subtitle") or "",
                    "score": c.get("score"),
                }
                for c in cands
            ]
            segment_candidates.append(rich)
            pick_debug.append(
                {
                    "segmentIndex": i,
                    "narration": narrations[i] if i < len(narrations) else seg.get("narration"),
                    "eventIds": seg.get("eventIds") or [],
                    "visualBeats": seg.get("visualBeats") or [],
                    "candidates": rich,
                }
            )
        write_json(work_dir / "candidates.json", pick_debug)
        if keep_debug:
            write_json(debug_dir / "candidates.json", pick_debug)

        # 7) TTS + measure audioDur
        edge_rate = format_edge_rate(
            cfg.get("edgeTtsRate"),
            default=format_edge_rate(cfg.get("edgeTtsRatePercent"), default="+0%"),
        )
        video_speed = float(cfg.get("videoSpeed") or 1.0)
        tts_engine = str(cfg.get("ttsEngine") or "omnivoice").strip().lower()
        step_start(7, "TTS", f"{len(narrations)} narrations · engine={tts_engine}")
        audio_dir = work_dir / "audio"
        audio_dir.mkdir(parents=True, exist_ok=True)
        tts_meta = synthesize_segments(
            narrations=narrations,
            out_dir=audio_dir,
            engine=tts_engine,
            voice=str(cfg.get("edgeTtsVoice") or "vi-VN-HoaiMyNeural"),
            rate=edge_rate,
            ref_audio=str(cfg.get("omnivoiceRefWav") or "").strip() or None,
            ref_text=str(cfg.get("omnivoiceRefText") or "").strip() or None,
            language=str(cfg.get("omnivoiceLanguage") or "vietnamese").strip() or "vietnamese",
        )
        write_json(work_dir / "tts.json", tts_meta)
        step_done(7, "TTS", f"{len(tts_meta)} audio files")

        # 8) CallB — shot planner + diversity (after TTS for real audioDur)
        step_start(8, "CallB", "shot planner + diversity")
        picks = plan_all_segments(
            segments,
            segment_candidates=segment_candidates,
            tts_meta=tts_meta,
            shots=shots,
            semantic=semantic,
            work_dir=work_dir,
        )
        sanitized = picks.get(PICKS_SELECTED_SHOTS) or []
        # Sanitize: only ids in shortlist; fallback fill
        fixed: list[list[int]] = []
        for i, chosen in enumerate(sanitized):
            allow = {int(c["id"]) for c in segment_candidates[i]} if i < len(segment_candidates) else set()
            row = [int(x) for x in (chosen or []) if int(x) in allow] if allow else [int(x) for x in (chosen or [])]
            if not row and i < len(segment_candidates) and segment_candidates[i]:
                need = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or 28)
                row = [int(c["id"]) for c in segment_candidates[i][: max(1, int(need / 3))]]
            fixed.append(row)
        while len(fixed) < len(narrations):
            i = len(fixed)
            if i < len(segment_candidates) and segment_candidates[i]:
                need = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or 28)
                fixed.append([int(c["id"]) for c in segment_candidates[i][: max(1, int(need / 3))]])
            else:
                fixed.append([])
        picks = {PICKS_SELECTED_SHOTS: fixed}
        write_json(work_dir / "picks.json", picks)
        step_done(8, "CallB", f"{len(fixed)} segments picked")

        # 9) Voice-master pack + render
        step_start(9, "Render", f"timeline + FFmpeg · videoSpeed={video_speed}x")
        timeline = pack_voice_master_timeline(
            shots=shots,
            picks=fixed,
            candidates=[[c["id"] for c in seg] for seg in segment_candidates],
            tts_meta=tts_meta,
            video_speed=video_speed,
        )
        write_json(work_dir / "timeline.json", timeline)

        out_dir = work_dir / "output"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_mp4 = out_dir / "recap.mp4"
        render_timeline(
            video=video,
            timeline=timeline,
            out_mp4=out_mp4,
            work_dir=work_dir,
            video_speed=video_speed,
        )
        if not out_mp4.exists():
            raise RuntimeError("Render finished but output missing")
        step_done(9, "Render", f"{timeline.get('durationSec')}s · {out_mp4}")

        cleanup_work_artifacts(work_dir, keep_debug=keep_debug)

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
