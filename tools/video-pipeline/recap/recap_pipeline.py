"""Shared recap pipeline context and per-step runners."""

from __future__ import annotations

import logging
import shutil
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401 — HF cache before torch/HF

from asr import (
    format_transcript_timestamped,
    load_srt_segments,
    merge_transcript_windows,
    parse_srt,
    run_asr,
    segments_to_srt,
    write_srt,
)
from clip_embeddings import load_shot_embeddings
from keyframes import VISUAL_VERSION
from call_a1_story_analyst import (
    analysis_markdown_from_knowledge,
    attach_candidate_shots,
    build_a1_payload,
    generate_story_knowledge,
)
from call_a2_script_writer import (
    derive_script_from_segments,
    generate_narration_segments,
    merged_candidates_for_segment,
)
from call_b_shot_planner import PICKS_PLAN_VERSION, plan_all_segments, sanitize_picks
from cluster import cluster_semantic_scenes
from gemini_recap import (
    PICKS_SELECTED_SHOTS,
    SCRIPT_DURATION_SEC,
    SCRIPT_MOVIE_WINDOWS,
    SCRIPT_NARRATIONS,
    canonicalize_script,
    validate_script,
)
from pipeline_cache import (
    artifact_fresh,
    knowledge_has_candidates,
    load_json,
    load_json_if_fresh,
    try_load_timeline_cache,
    try_load_tts_cache,
    tts_signature,
    write_json,
)
from qwen_vl import describe_candidate_events, knowledge_has_vlm
from render import render_timeline
from scenes import detect_shots
from timeline import pack_voice_master_timeline
from tts import format_edge_rate, synthesize_segments

LOG = logging.getLogger("recap")
TOTAL_STEPS = 10

STEP_IDS = (
    "asr",
    "scenes",
    "cluster",
    "call_a1",
    "candidates",
    "vlm",
    "call_a2",
    "tts",
    "call_b",
    "render",
)

STEP_SCRIPT_NAMES: dict[str, str] = {
    "asr": "step_01_asr.py",
    "scenes": "step_02_scenes.py",
    "cluster": "step_03_cluster.py",
    "call_a1": "step_04_call_a1.py",
    "candidates": "step_05_candidates.py",
    "vlm": "step_vlm.py",
    "call_a2": "step_06_call_a2.py",
    "tts": "step_07_tts.py",
    "call_b": "step_08_call_b.py",
    "render": "step_09_render.py",
}


def step_number(step_id: str) -> int:
    try:
        return STEP_IDS.index(step_id) + 1
    except ValueError as exc:
        raise ValueError(f"Unknown step: {step_id}") from exc


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

    for noisy in (
        "httpx",
        "httpcore",
        "huggingface_hub",
        "urllib3",
        "filelock",
        "open_clip",
        "PIL",
        "matplotlib",
        "transformers",
        "asyncio",
        "google",
        "google_genai",
        "faster_whisper",
        "numba",
        "torch",
        "tensorflow",
    ):
        logging.getLogger(noisy).setLevel(logging.WARNING)


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


def write_debug_index(debug_dir: Path, work_dir: Path) -> None:
    lines = [
        "Recap debug artifacts (pipeline v2)",
        "===================================",
        "",
        f"Work dir: {work_dir}",
        "",
    ]
    debug_dir.mkdir(parents=True, exist_ok=True)
    (debug_dir / "README.txt").write_text("\n".join(lines), encoding="utf-8")


def cleanup_work_artifacts(work_dir: Path, keep_debug: bool) -> None:
    if keep_debug:
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


class RecapContext:
    """Pipeline state loaded from work dir between steps."""

    def __init__(self, video: Path, work_dir: Path, cfg: dict[str, Any]) -> None:
        self.video = video.resolve()
        self.work_dir = work_dir.resolve()
        self.cfg = cfg
        self.title = str(cfg.get("title") or cfg.get("displayName") or video.stem)
        self.dur_min = int(cfg.get("durationMinSec") or 900)
        self.dur_max = int(cfg.get("durationMaxSec") or 1200)
        self.wpm = int(cfg.get("wordsPerMinute") or 140)
        self.locale = str(cfg.get("locale") or "vi")
        self.year = cfg.get("year")
        self.keep_debug = bool(cfg.get("keepDebugArtifacts", True))
        self.debug_dir = self.work_dir / "debug"
        self.gemini_model = str(cfg.get("geminiModel") or "")
        self.gemini_tier = str(cfg.get("geminiKeyTier") or cfg.get("gemini_key_tier") or "")
        self.video_speed = float(cfg.get("videoSpeed") or 1.0)
        self.tts_engine = str(cfg.get("ttsEngine") or "omnivoice").strip().lower()
        self.edge_rate = format_edge_rate(
            cfg.get("edgeTtsRate"),
            default=format_edge_rate(cfg.get("edgeTtsRatePercent"), default="+0%"),
        )
        self.movie_dur = probe_duration(self.video)

        if self.keep_debug:
            write_debug_index(self.debug_dir, self.work_dir)

    def load_transcript(self) -> dict[str, Any]:
        srt_path = self.work_dir / "transcript.srt"
        json_path = self.work_dir / "transcript.json"
        if srt_path.is_file():
            text = srt_path.read_text(encoding="utf-8")
            return {"language": "unknown", "segments": parse_srt(text), "srt": text}
        if json_path.is_file():
            data = load_json(json_path)
            if not isinstance(data, dict):
                raise FileNotFoundError("transcript.srt missing — run ASR first")
            segs = data.get("segments") or []
            return {
                "language": data.get("language") or "unknown",
                "segments": segs,
                "srt": segments_to_srt(segs) if isinstance(segs, list) else "",
            }
        raise FileNotFoundError("transcript.srt missing — run ASR first")

    def load_shots(self) -> list[dict[str, Any]]:
        path = self.work_dir / "shots.json"
        data = load_json(path)
        if not isinstance(data, list):
            raise FileNotFoundError("shots.json missing — run Scenes first")
        return data

    def load_semantic(self) -> dict[str, Any]:
        path = self.work_dir / "semantic_scenes.json"
        data = load_json(path)
        if not isinstance(data, dict):
            raise FileNotFoundError("semantic_scenes.json missing — run Cluster first")
        return data

    def load_knowledge(self) -> dict[str, Any]:
        path = self.work_dir / "story_knowledge.json"
        data = load_json(path)
        if not isinstance(data, dict):
            raise FileNotFoundError("story_knowledge.json missing — run CallA-1 first")
        return data

    def load_segments_and_script(self) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        segments_path = self.work_dir / "segments.json"
        script_path = self.work_dir / "script.json"
        if not segments_path.exists() or not script_path.exists():
            raise FileNotFoundError("segments.json / script.json missing — run CallA-2 first")
        segments_raw = load_json(segments_path)
        segments = segments_raw.get("segments") if isinstance(segments_raw, dict) else segments_raw
        if not isinstance(segments, list):
            raise FileNotFoundError("segments.json invalid")
        script = load_json(script_path)
        if not isinstance(script, dict):
            raise FileNotFoundError("script.json invalid")
        return segments, script

    def build_segment_candidates(
        self,
        segments: list[dict[str, Any]],
        knowledge: dict[str, Any],
        narrations: list[str],
    ) -> tuple[list[list[dict[str, Any]]], list[dict[str, Any]]]:
        segment_candidates: list[list[dict[str, Any]]] = []
        pick_debug: list[dict[str, Any]] = []
        for i, seg in enumerate(segments):
            cands = merged_candidates_for_segment(seg, knowledge)
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
        return segment_candidates, pick_debug


def run_step_asr(ctx: RecapContext) -> None:
    n = 1
    step_start(n, "ASR", "Whisper SRT")
    srt_path = ctx.work_dir / "transcript.srt"
    json_path = ctx.work_dir / "transcript.json"
    if artifact_fresh(srt_path):
        segs = load_srt_segments(srt_path)
        step_done(n, "ASR", f"cache hit ({len(segs)} cues)")
        return
    if json_path.is_file():
        legacy = load_json(json_path)
        segs = legacy.get("segments") if isinstance(legacy, dict) else None
        if isinstance(segs, list) and segs:
            write_srt(srt_path, segs)
            try:
                json_path.unlink()
            except OSError:
                pass
            step_done(n, "ASR", f"migrated JSON → SRT ({len(segs)} cues)")
            return
    transcript = run_asr(ctx.video, ctx.work_dir)
    write_srt(srt_path, transcript.get("segments") or [])
    if json_path.is_file():
        try:
            json_path.unlink()
        except OSError:
            pass
    step_done(n, "ASR", f"{len(transcript.get('segments') or [])} cues")


def run_step_scenes(ctx: RecapContext) -> None:
    n = 2
    step_start(n, "Scenes", "shot detect (TransNet / FFmpeg)")
    shots_path = ctx.work_dir / "shots.json"
    shots = load_json_if_fresh(shots_path)
    if shots is not None:
        step_done(n, "Scenes", f"cache hit ({len(shots)} shots)")
        return
    shots = detect_shots(ctx.video, ctx.work_dir, ctx.movie_dur)
    write_json(shots_path, shots)
    step_done(n, "Scenes", f"{len(shots)} shots")


def run_step_cluster(ctx: RecapContext) -> None:
    n = 3
    shots = ctx.load_shots()
    step_start(n, "Cluster", "OpenCLIP semantic scenes")
    scenes_path = ctx.work_dir / "semantic_scenes.json"
    shots_path = ctx.work_dir / "shots.json"
    semantic = load_json_if_fresh(scenes_path, shots_path)
    has_kf = bool(
        isinstance(shots, list)
        and shots
        and isinstance(shots[0], dict)
        and (shots[0].get("keyframes") or {}).get("primary")
    )
    if (
        semantic is not None
        and str(semantic.get("visualVersion") or "") == VISUAL_VERSION
        and has_kf
    ):
        step_done(n, "Cluster", f"cache hit ({len(semantic.get('scenes', []))} scenes)")
        return
    tr_segs: list = []
    try:
        tr_segs = list(ctx.load_transcript().get("segments") or [])
    except Exception:
        tr_segs = []
    semantic = cluster_semantic_scenes(
        ctx.video,
        shots,
        ctx.work_dir,
        transcript_segments=tr_segs,
        cfg=ctx.cfg,
    )
    for s in shots:
        if isinstance(s, dict):
            s.pop("_secondaryEmbeddings", None)
    write_json(shots_path, shots)
    write_json(scenes_path, semantic)
    step_done(n, "Cluster", f"{len(semantic.get('scenes', []))} scenes")


def run_step_call_a1(ctx: RecapContext) -> None:
    n = 4
    transcript = ctx.load_transcript()
    semantic = ctx.load_semantic()
    srt_text = str(transcript.get("srt") or "").strip() or format_transcript_timestamped(
        transcript.get("segments", [])
    )
    tr_merged = merge_transcript_windows(transcript.get("segments", []), window_sec=30.0)

    step_start(n, "CallA-1", "film analysis")
    knowledge_path = ctx.work_dir / "story_knowledge.json"
    analysis_path = ctx.work_dir / "story_analysis.md"
    if knowledge_path.exists():
        knowledge = load_json(knowledge_path)
        if not analysis_path.exists() and isinstance(knowledge, dict):
            analysis_path.write_text(
                analysis_markdown_from_knowledge(
                    knowledge,
                    video_name=ctx.video.name,
                    movie_dur=ctx.movie_dur,
                ),
                encoding="utf-8",
            )
        step_done(n, "CallA-1", f"cache hit ({len(knowledge.get('events', []))} events)")
        return

    payload_a1 = build_a1_payload(
        movie_title=ctx.title,
        movie_duration=ctx.movie_dur,
        srt=srt_text,
        video_file_name=ctx.video.name,
    )
    if ctx.year is not None:
        payload_a1["year"] = ctx.year
    knowledge, analysis_md = generate_story_knowledge(
        payload_a1,
        model=ctx.gemini_model,
        key_tier=ctx.gemini_tier,
        debug_dir=ctx.debug_dir if ctx.keep_debug else None,
        movie_title=ctx.title,
        movie_dur=ctx.movie_dur,
        transcript_summary=tr_merged,
        semantic=semantic,
    )
    write_json(knowledge_path, knowledge)
    analysis_path.write_text(analysis_md, encoding="utf-8")
    if ctx.keep_debug:
        ctx.debug_dir.mkdir(parents=True, exist_ok=True)
        (ctx.debug_dir / "story_analysis.md").write_text(analysis_md, encoding="utf-8")
    step_done(
        n,
        "CallA-1",
        f"{len(knowledge.get('events', []))} events · {len(knowledge.get('characters', []))} chars",
    )


def run_step_candidates(ctx: RecapContext) -> None:
    n = 5
    transcript = ctx.load_transcript()
    shots = ctx.load_shots()
    semantic = ctx.load_semantic()
    knowledge = ctx.load_knowledge()
    transcript_segments = transcript.get("segments") or []

    step_start(n, "Candidates", "attach shots per event window")
    knowledge_path = ctx.work_dir / "story_knowledge.json"
    if knowledge_has_candidates(knowledge):
        step_done(n, "Candidates", "cache hit")
        return

    knowledge = attach_candidate_shots(
        knowledge,
        shots=shots,
        semantic=semantic,
        transcript_segments=transcript_segments,
        embeddings=load_shot_embeddings(ctx.work_dir),
    )
    write_json(knowledge_path, knowledge)
    n_cands = sum(len(e.get("candidate_shots") or []) for e in knowledge.get("events") or [])
    step_done(n, "Candidates", f"{n_cands} candidate links")


def run_step_vlm(ctx: RecapContext) -> None:
    n = 6
    knowledge = ctx.load_knowledge()
    shots = ctx.load_shots()
    step_start(n, "VLM", "Qwen2.5-VL on shortlisted keyframes")
    knowledge_path = ctx.work_dir / "story_knowledge.json"
    vlm_path = ctx.work_dir / "vlm_evidence.json"
    if knowledge_has_vlm(knowledge):
        step_done(n, "VLM", "cache hit")
        return
    if vlm_path.exists():
        cached = load_json(vlm_path)
        knowledge_mtime = knowledge_path.stat().st_mtime if knowledge_path.exists() else 0
        if (
            isinstance(cached, dict)
            and cached.get("skipped")
            and vlm_path.stat().st_mtime >= knowledge_mtime
        ):
            step_done(n, "VLM", f"skipped ({cached.get('reason')})")
            return
    meta = describe_candidate_events(
        knowledge,
        shots=shots,
        work_dir=ctx.work_dir,
        cfg=ctx.cfg,
        locale=ctx.locale,
    )
    write_json(knowledge_path, knowledge)
    write_json(vlm_path, meta)
    if ctx.keep_debug:
        ctx.debug_dir.mkdir(parents=True, exist_ok=True)
        write_json(ctx.debug_dir / "vlm_evidence.json", meta)
    if meta.get("skipped"):
        step_done(n, "VLM", f"skipped ({meta.get('reason')})")
        return
    step_done(n, "VLM", f"{meta.get('eventCount', 0)} events · {meta.get('imageCount', 0)} frames")


def run_step_call_a2(ctx: RecapContext) -> None:
    n = 7
    knowledge = ctx.load_knowledge()
    step_start(n, "CallA-2", "script writer + visual beats")
    script_path = ctx.work_dir / "script.json"
    segments_path = ctx.work_dir / "segments.json"
    if (
        script_path.exists()
        and segments_path.exists()
        and artifact_fresh(segments_path, script_path)
    ):
        segments_raw = load_json(segments_path)
        segments = segments_raw.get("segments") if isinstance(segments_raw, dict) else segments_raw
        script = load_json(script_path)
        step_done(n, "CallA-2", f"cache hit ({len(segments or [])} segments)")
        return

    segments = generate_narration_segments(
        knowledge,
        locale=ctx.locale,
        dur_min=ctx.dur_min,
        dur_max=ctx.dur_max,
        wpm=ctx.wpm,
        model=ctx.gemini_model,
        key_tier=ctx.gemini_tier,
        debug_dir=ctx.debug_dir if ctx.keep_debug else None,
    )
    write_json(segments_path, {"segments": segments})
    script = derive_script_from_segments(segments, knowledge, movie_dur=ctx.movie_dur)
    script = canonicalize_script(script)
    validate_script(
        script,
        dur_min=ctx.dur_min,
        dur_max=ctx.dur_max,
        movie_dur=ctx.movie_dur,
        wpm=ctx.wpm,
    )
    write_json(script_path, script)
    write_json(segments_path, {"segments": segments})
    step_done(n, "CallA-2", f"{len(segments)} segments · {script.get(SCRIPT_DURATION_SEC)}s")


def run_step_tts(ctx: RecapContext) -> None:
    n = 8
    segments, script = ctx.load_segments_and_script()
    knowledge = ctx.load_knowledge()
    narrations = script[SCRIPT_NARRATIONS]
    if len(segments) != len(narrations) and len(segments) > len(narrations):
        segments = segments[: len(narrations)]

    _, pick_debug = ctx.build_segment_candidates(segments, knowledge, narrations)
    write_json(ctx.work_dir / "candidates.json", pick_debug)
    if ctx.keep_debug:
        write_json(ctx.debug_dir / "candidates.json", pick_debug)

    step_start(n, "TTS", f"{len(narrations)} narrations · engine={ctx.tts_engine}")
    script_path = ctx.work_dir / "script.json"
    tts_path = ctx.work_dir / "tts.json"
    tts_sig = tts_signature(
        ctx.tts_engine,
        voice=str(ctx.cfg.get("edgeTtsVoice") or "vi-VN-HoaiMyNeural"),
        rate=ctx.edge_rate,
        ref_audio=str(ctx.cfg.get("omnivoiceRefWav") or "").strip() or None,
        ref_text=str(ctx.cfg.get("omnivoiceRefText") or "").strip() or None,
        language=str(ctx.cfg.get("omnivoiceLanguage") or "vietnamese").strip() or "vietnamese",
    )
    audio_dir = ctx.work_dir / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)
    cached_tts = try_load_tts_cache(tts_path, narrations, tts_sig, script_path=script_path)
    if cached_tts is not None:
        step_done(n, "TTS", f"cache hit ({len(cached_tts)} audio files)")
        return

    tts_meta = synthesize_segments(
        narrations=narrations,
        out_dir=audio_dir,
        engine=ctx.tts_engine,
        voice=str(ctx.cfg.get("edgeTtsVoice") or "vi-VN-HoaiMyNeural"),
        rate=ctx.edge_rate,
        ref_audio=str(ctx.cfg.get("omnivoiceRefWav") or "").strip() or None,
        ref_text=str(ctx.cfg.get("omnivoiceRefText") or "").strip() or None,
        language=str(ctx.cfg.get("omnivoiceLanguage") or "vietnamese").strip() or "vietnamese",
        skip_existing=True,
    )
    write_json(tts_path, tts_meta)
    step_done(n, "TTS", f"{len(tts_meta)} audio files")


def run_step_call_b(ctx: RecapContext) -> None:
    n = 9
    shots = ctx.load_shots()
    semantic = ctx.load_semantic()
    knowledge = ctx.load_knowledge()
    segments, script = ctx.load_segments_and_script()
    narrations = script[SCRIPT_NARRATIONS]
    if len(segments) != len(narrations) and len(segments) > len(narrations):
        segments = segments[: len(narrations)]

    tts_path = ctx.work_dir / "tts.json"
    if not tts_path.exists():
        raise FileNotFoundError("tts.json missing — run TTS first")
    tts_meta = load_json(tts_path)

    segment_candidates, _ = ctx.build_segment_candidates(segments, knowledge, narrations)

    step_start(n, "CallB", "shot planner + diversity")
    picks_path = ctx.work_dir / "picks.json"
    segments_path = ctx.work_dir / "segments.json"
    script_path = ctx.work_dir / "script.json"
    if artifact_fresh(picks_path, tts_path, segments_path, script_path):
        picks = load_json(picks_path)
        cached_rows = picks.get(PICKS_SELECTED_SHOTS) if isinstance(picks, dict) else None
        cached_ok = (
            isinstance(picks, dict)
            and picks.get("planVersion") == PICKS_PLAN_VERSION
            and isinstance(cached_rows, list)
            and len(cached_rows) == len(narrations)
            and all(isinstance(row, list) and len(row) > 0 for row in cached_rows)
        )
        if cached_ok:
            step_done(n, "CallB", f"cache hit ({len(cached_rows)} segments)")
            return

    picks = plan_all_segments(
        segments,
        segment_candidates=segment_candidates,
        tts_meta=tts_meta,
        shots=shots,
        semantic=semantic,
        work_dir=ctx.work_dir,
        cfg=ctx.cfg,
        knowledge=knowledge,
        movie_windows=script.get(SCRIPT_MOVIE_WINDOWS) or [],
    )
    debug_rank = picks.pop("_debugRanking", None)
    fixed = sanitize_picks(
        picks.get(PICKS_SELECTED_SHOTS),
        segment_candidates=segment_candidates,
        tts_meta=tts_meta,
        narrations=narrations,
        shots=shots,
        cfg=ctx.cfg,
        movie_windows=script.get(SCRIPT_MOVIE_WINDOWS) or [],
        segments=segments,
        knowledge=knowledge,
    )
    out_picks = {PICKS_SELECTED_SHOTS: fixed, "planVersion": PICKS_PLAN_VERSION}
    if ctx.keep_debug:
        out_picks["selectedShotsDetail"] = picks.get("selectedShotsDetail") or []
    write_json(picks_path, out_picks)
    if ctx.keep_debug and debug_rank:
        ctx.debug_dir.mkdir(parents=True, exist_ok=True)
        write_json(ctx.debug_dir / "call_b_ranking.json", debug_rank)
    step_done(n, "CallB", f"{len(fixed)} segments picked")


def run_step_render(ctx: RecapContext) -> Path:
    n = 10
    shots = ctx.load_shots()
    knowledge = ctx.load_knowledge()
    segments, script = ctx.load_segments_and_script()
    narrations = script[SCRIPT_NARRATIONS]
    if len(segments) != len(narrations) and len(segments) > len(narrations):
        segments = segments[: len(narrations)]

    tts_path = ctx.work_dir / "tts.json"
    picks_path = ctx.work_dir / "picks.json"
    if not tts_path.exists():
        raise FileNotFoundError("tts.json missing — run TTS first")
    if not picks_path.exists():
        raise FileNotFoundError("picks.json missing — run CallB first")

    tts_meta = load_json(tts_path)
    picks = load_json(picks_path)
    fixed = picks.get(PICKS_SELECTED_SHOTS) or []
    segment_candidates, _ = ctx.build_segment_candidates(segments, knowledge, narrations)

    step_start(n, "Render", f"timeline + FFmpeg · videoSpeed={ctx.video_speed}x")
    timeline_path = ctx.work_dir / "timeline.json"
    script_path = ctx.work_dir / "script.json"
    timeline = try_load_timeline_cache(timeline_path, ctx.cfg, picks_path, tts_path, script_path)
    render_note = "timeline cache hit"
    if timeline is None:
        timeline = pack_voice_master_timeline(
            shots=shots,
            picks=fixed,
            candidates=[[c["id"] for c in seg] for seg in segment_candidates],
            tts_meta=tts_meta,
            video_speed=ctx.video_speed,
        )
        write_json(timeline_path, timeline)
        render_note = "timeline built"

    out_dir = ctx.work_dir / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_mp4 = out_dir / "recap.mp4"
    if artifact_fresh(out_mp4, timeline_path):
        step_done(n, "Render", f"{render_note} · video cache hit · {out_mp4}")
        return out_mp4

    render_timeline(
        video=ctx.video,
        timeline=timeline,
        out_mp4=out_mp4,
        work_dir=ctx.work_dir,
        video_speed=ctx.video_speed,
    )
    if not out_mp4.exists():
        raise RuntimeError("Render finished but output missing")
    step_done(n, "Render", f"{render_note} · {timeline.get('durationSec')}s · {out_mp4}")
    cleanup_work_artifacts(ctx.work_dir, keep_debug=ctx.keep_debug)
    return out_mp4


STEP_RUNNERS: dict[str, Any] = {
    "asr": run_step_asr,
    "scenes": run_step_scenes,
    "cluster": run_step_cluster,
    "call_a1": run_step_call_a1,
    "candidates": run_step_candidates,
    "vlm": run_step_vlm,
    "call_a2": run_step_call_a2,
    "tts": run_step_tts,
    "call_b": run_step_call_b,
    "render": run_step_render,
}


def run_single_step(step_id: str, video: Path, work_dir: Path, cfg: dict[str, Any]) -> Path | None:
    """Run one pipeline step. Returns output mp4 path for render step."""
    if step_id not in STEP_RUNNERS:
        raise ValueError(f"Unknown step: {step_id}")

    work_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(work_dir)

    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")

    ctx = RecapContext(video, work_dir, cfg)
    LOG.info(
        "[RECAP] step=%s title=%s source=%.0fs work=%s",
        step_id,
        ctx.title,
        ctx.movie_dur,
        work_dir,
    )

    runner = STEP_RUNNERS[step_id]
    result = runner(ctx)
    if step_id == "render":
        return result
    return None


def run_all_steps(video: Path, work_dir: Path, cfg: dict[str, Any]) -> Path:
    """Run full pipeline (legacy orchestrator)."""
    work_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(work_dir)

    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")

    ctx = RecapContext(video, work_dir, cfg)
    LOG.info(
        "[RECAP] start title=%s source=%.0fs target=%d–%ds work=%s",
        ctx.title,
        ctx.movie_dur,
        ctx.dur_min,
        ctx.dur_max,
        work_dir,
    )

    for step_id in STEP_IDS:
        if step_id == "render":
            out = run_step_render(ctx)
            return out
        STEP_RUNNERS[step_id](ctx)

    raise RuntimeError("Render step did not run")


def main_step_script(step_id: str) -> int:
    """CLI entry for individual step_*.py scripts."""
    import argparse

    parser = argparse.ArgumentParser(description=f"Recap pipeline step: {step_id}")
    parser.add_argument("--video", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()

    print(f"[RECAP] boot step={step_id}", flush=True)
    try:
        cfg = load_json(Path(args.config))
        out = run_single_step(step_id, Path(args.video), Path(args.work_dir), cfg)
        if out is not None:
            print(f"DONE: {out}", flush=True)
        else:
            print(f"DONE: step={step_id}", flush=True)
        return 0
    except Exception as exc:
        msg = str(exc)
        LOG.error("[RECAP_FAILED] %s\n%s", msg, traceback.format_exc())
        print(f"[RECAP_FAILED] {msg}", file=sys.stderr)
        return 1
