"""Narrato FILM_SUMMARY + MODE_SHORT pipeline (no Streamlit, no recap imports)."""

from __future__ import annotations

import json
import logging
import shutil
import traceback
from pathlib import Path
from typing import Any

from asr import format_subtitle_content, parse_srt, run_asr, segments_to_srt
from gemini_client import generate_json, generate_text
from prompts import (
    COPY_SYSTEM,
    COPY_TEMPLATE,
    MATCH_SYSTEM,
    MATCH_TEMPLATE,
    MIX_PLOT_SYSTEM,
    MIX_PLOT_TEMPLATE,
    MIX_SCRIPT_SYSTEM,
    MIX_SCRIPT_TEMPLATE,
    PLOT_SYSTEM,
    PLOT_TEMPLATE,
    fill,
)
from render import render_items
from script import normalize_items, script_payload

LOG = logging.getLogger("narrato")
STEP_IDS = ("ingest", "plot", "copy", "match", "mix", "render")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text or "", encoding="utf-8")


def read_text(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8")


def setup_logging(work_dir: Path) -> None:
    log_dir = work_dir / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "pipeline.log"
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    fmt = logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    for handler in list(root.handlers):
        if getattr(handler, "_narrato_file", False):
            root.removeHandler(handler)
    fh = logging.FileHandler(log_path, encoding="utf-8")
    fh.setFormatter(fmt)
    fh._narrato_file = True  # type: ignore[attr-defined]
    root.addHandler(fh)
    if not any(isinstance(h, logging.StreamHandler) and not isinstance(h, logging.FileHandler) for h in root.handlers):
        sh = logging.StreamHandler()
        sh.setFormatter(fmt)
        root.addHandler(sh)


class NarratoContext:
    def __init__(self, video: Path, work_dir: Path, cfg: dict[str, Any]):
        self.video = video
        self.work_dir = work_dir
        self.cfg = cfg
        self.mode = str(cfg.get("mode") or "film_summary").strip() or "film_summary"
        self.title = str(cfg.get("title") or cfg.get("displayName") or video.stem)
        self.genre = str(cfg.get("dramaGenre") or cfg.get("genre") or "Drama / emotion")
        self.narration_language = str(cfg.get("narrationLanguage") or "Vietnamese (Vietnam)")
        self.original_sound_ratio = int(cfg.get("originalSoundRatio") or 30)
        self.narration_word_count = int(cfg.get("narrationWordCount") or 500)
        self.custom_clips = int(cfg.get("customClips") or 5)
        self.subtitle_source = str(cfg.get("subtitleSource") or "whisper").strip().lower()
        self.whisper_language = str(cfg.get("whisperLanguage") or "vi").strip() or "vi"
        self.srt_path = str(cfg.get("srtPath") or cfg.get("localSrtPath") or "").strip()
        self.gemini_model = str(cfg.get("geminiModel") or "")
        self.gemini_tier = str(cfg.get("geminiKeyTier") or cfg.get("gemini_key_tier") or "vip")
        self.edge_voice = str(cfg.get("edgeTtsVoice") or "vi-VN-HoaiMyNeural")
        self.edge_rate = str(cfg.get("edgeTtsRate") or "+0%")
        self.tts_engine = str(cfg.get("ttsEngine") or "edge").strip() or "edge"
        self.omnivoice_ref_wav = str(cfg.get("omnivoiceRefWav") or "").strip()
        self.omnivoice_ref_text = str(cfg.get("omnivoiceRefText") or "").strip()
        self.omnivoice_language = str(cfg.get("omnivoiceLanguage") or "").strip()

    @property
    def debug_dir(self) -> Path:
        d = self.work_dir / "debug"
        d.mkdir(parents=True, exist_ok=True)
        return d

    def subtitle_text(self) -> str:
        path = self.work_dir / "transcript.srt"
        if not path.exists():
            raise RuntimeError("transcript.srt missing — run ingest first")
        return format_subtitle_content(read_text(path), self.video.name)


def run_step_ingest(ctx: NarratoContext) -> None:
    LOG.info("[STEP 1/6] ingest — source=%s lang=%s", ctx.subtitle_source, ctx.whisper_language)
    dest = ctx.work_dir / "transcript.srt"
    if ctx.subtitle_source == "upload":
        src = Path(ctx.srt_path)
        if not src.exists():
            raise FileNotFoundError(f"SRT not found: {ctx.srt_path}")
        shutil.copyfile(src, dest)
        segs = parse_srt(read_text(dest))
        write_json(ctx.work_dir / "transcript.json", {"language": "upload", "segments": segs})
        LOG.info("[STEP 1/6] ingest done — copied %s cues", len(segs))
        return

    result = run_asr(ctx.video, ctx.work_dir, language=ctx.whisper_language)
    write_json(ctx.work_dir / "transcript.json", result)
    srt = segments_to_srt(result.get("segments") or [])
    if not srt.strip():
        raise RuntimeError("Whisper produced empty transcript")
    write_text(dest, srt)
    LOG.info("[STEP 1/6] ingest done — whisper language=%s cues=%s", result.get("language"), len(result.get("segments") or []))


def run_step_plot(ctx: NarratoContext) -> None:
    LOG.info("[STEP 2/6] plot")
    subtitle = ctx.subtitle_text()
    if ctx.mode == "short":
        user = fill(MIX_PLOT_TEMPLATE, subtitle_content=subtitle, custom_clips=ctx.custom_clips)
        data = generate_json(
            MIX_PLOT_SYSTEM,
            user,
            model=ctx.gemini_model,
            key_tier=ctx.gemini_tier,
            debug_dir=ctx.debug_dir,
            debug_tag="plot_mix",
        )
        plot = json.dumps(data, ensure_ascii=False, indent=2)
    else:
        user = fill(PLOT_TEMPLATE, subtitle_content=subtitle)
        plot = generate_text(
            PLOT_SYSTEM,
            user,
            model=ctx.gemini_model,
            key_tier=ctx.gemini_tier,
            debug_dir=ctx.debug_dir,
            debug_tag="plot_film",
        )
    if not str(plot).strip():
        raise RuntimeError("Plot analysis returned empty text")
    write_text(ctx.work_dir / "plot.md", str(plot).strip())
    LOG.info("[STEP 2/6] plot done")


def run_step_copy(ctx: NarratoContext) -> None:
    if ctx.mode == "short":
        LOG.info("[STEP 3/6] copy skipped (short mix-cut)")
        write_text(ctx.work_dir / "narration_copy.txt", "")
        return
    LOG.info("[STEP 3/6] copy")
    plot = read_text(ctx.work_dir / "plot.md")
    if not plot.strip():
        raise RuntimeError("plot.md missing — run plot first")
    user = fill(
        COPY_TEMPLATE,
        drama_name=ctx.title,
        plot_analysis=plot,
        subtitle_content=ctx.subtitle_text(),
        narration_language=ctx.narration_language,
        drama_genre=ctx.genre,
        narration_word_count=ctx.narration_word_count,
    )
    copy = generate_text(
        COPY_SYSTEM,
        user,
        model=ctx.gemini_model,
        key_tier=ctx.gemini_tier,
        debug_dir=ctx.debug_dir,
        debug_tag="copy",
        temperature=0.7,
    )
    if not copy.strip():
        raise RuntimeError("Narration copy returned empty text")
    write_text(ctx.work_dir / "narration_copy.txt", copy.strip())
    LOG.info("[STEP 3/6] copy done")


def run_step_match(ctx: NarratoContext) -> None:
    if ctx.mode == "short":
        LOG.info("[STEP 4/6] match skipped (short mix-cut)")
        return
    LOG.info("[STEP 4/6] match")
    plot = read_text(ctx.work_dir / "plot.md")
    copy = read_text(ctx.work_dir / "narration_copy.txt")
    if not copy.strip():
        raise RuntimeError("narration_copy.txt missing — run copy first")
    user = fill(
        MATCH_TEMPLATE,
        drama_name=ctx.title,
        plot_analysis=plot,
        narration_copy=copy,
        subtitle_content=ctx.subtitle_text(),
        narration_language=ctx.narration_language,
        drama_genre=ctx.genre,
        original_sound_ratio=ctx.original_sound_ratio,
    )
    data = generate_json(
        MATCH_SYSTEM,
        user,
        model=ctx.gemini_model,
        key_tier=ctx.gemini_tier,
        debug_dir=ctx.debug_dir,
        debug_tag="match",
        temperature=0.3,
    )
    items = normalize_items(data, ctx.video.name)
    write_json(ctx.work_dir / "script.json", script_payload(items))
    LOG.info("[STEP 4/6] match done — %s items", len(items))


def run_step_mix(ctx: NarratoContext) -> None:
    if ctx.mode != "short":
        LOG.info("[STEP 5/6] mix skipped (film_summary)")
        return
    LOG.info("[STEP 5/6] mix")
    plot = read_text(ctx.work_dir / "plot.md")
    if not plot.strip():
        raise RuntimeError("plot.md missing — run plot first")
    user = fill(
        MIX_SCRIPT_TEMPLATE,
        drama_name=ctx.title,
        drama_genre=ctx.genre,
        custom_clips=ctx.custom_clips,
        plot_analysis=plot,
        subtitle_content=ctx.subtitle_text(),
    )
    data = generate_json(
        MIX_SCRIPT_SYSTEM,
        user,
        model=ctx.gemini_model,
        key_tier=ctx.gemini_tier,
        debug_dir=ctx.debug_dir,
        debug_tag="mix",
        temperature=0.3,
    )
    items = normalize_items(data, ctx.video.name)
    for item in items:
        item["OST"] = 1
        item["narration"] = f"ORIG{item['_id']}"
    write_json(ctx.work_dir / "script.json", script_payload(items))
    LOG.info("[STEP 5/6] mix done — %s items", len(items))


def run_step_render(ctx: NarratoContext) -> Path:
    LOG.info("[STEP 6/6] render")
    payload = load_json(ctx.work_dir / "script.json")
    items = normalize_items(payload, ctx.video.name)
    out_dir = ctx.work_dir / "output"
    out_mp4 = out_dir / "narrato.mp4"
    render_items(
        ctx.video,
        items,
        ctx.work_dir,
        out_mp4,
        voice=ctx.edge_voice,
        rate=ctx.edge_rate,
        tts_engine=ctx.tts_engine,
        ref_audio=ctx.omnivoice_ref_wav or None,
        ref_text=ctx.omnivoice_ref_text or None,
        tts_language=ctx.omnivoice_language or ctx.narration_language,
    )
    LOG.info("[STEP 6/6] render done — %s", out_mp4)
    return out_mp4


STEP_RUNNERS: dict[str, Any] = {
    "ingest": run_step_ingest,
    "plot": run_step_plot,
    "copy": run_step_copy,
    "match": run_step_match,
    "mix": run_step_mix,
    "render": run_step_render,
}


def run_single_step(step_id: str, video: Path, work_dir: Path, cfg: dict[str, Any]) -> Path | None:
    if step_id not in STEP_RUNNERS:
        raise ValueError(f"Unknown step: {step_id}")
    work_dir.mkdir(parents=True, exist_ok=True)
    setup_logging(work_dir)
    if not video.exists():
        raise FileNotFoundError(f"Video not found: {video}")
    ctx = NarratoContext(video, work_dir, cfg)
    LOG.info("[NARRATO] step=%s mode=%s title=%s work=%s", step_id, ctx.mode, ctx.title, work_dir)
    result = STEP_RUNNERS[step_id](ctx)
    if step_id == "render":
        return result
    return None


def main_step_script(step_id: str) -> int:
    import argparse
    import sys

    parser = argparse.ArgumentParser(description=f"Narrato pipeline step: {step_id}")
    parser.add_argument("--video", required=True)
    parser.add_argument("--work-dir", required=True)
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    print(f"[NARRATO] boot step={step_id}", flush=True)
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
        LOG.error("[NARRATO_FAILED] %s\n%s", msg, traceback.format_exc())
        print(f"[NARRATO_FAILED] {msg}", file=sys.stderr)
        return 1
