"""ShortVideo render entrypoint.

Flow: load asset -> build timeline -> build subtitle -> FFmpeg builder -> render.

Usage:
  python render.py --config job_config.json [--work-dir DIR]

job_config.json:
  {
    "spec": { background, left:{title,image}, right:{title,image}, voice, scenes:[...] },
    "engineConfig": { width, height, fps, bitrate, font, fontSize, safeMargin, ... },
    "assetsDir": "/abs/or/relative/dir/holding/the/asset/files"
  }

Prints "[STEP x/6] ..." progress lines and a final "DONE: <abs mp4 path>".
On failure prints "[SHORTVIDEO_FAILED] <message>" and exits non-zero.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from shortvideo.config import RenderConfig
from shortvideo.ffmpeg_builder import FFmpegBuilder
from shortvideo.subtitle import build_ass
from shortvideo.timeline import Timeline

SCRIPT_DIR = Path(__file__).resolve().parent
DRAGON_ASSETS_DIR = SCRIPT_DIR / "assets" / "dragon"


def _log(step: int, total: int, message: str) -> None:
    print(f"[STEP {step}/{total}] {message}", flush=True)


def _resolve_asset(name: str | None, assets_dir: Path) -> Path | None:
    if not name:
        return None
    candidate = Path(str(name))
    if candidate.is_absolute():
        return candidate if candidate.is_file() else None
    resolved = (assets_dir / candidate).resolve()
    return resolved if resolved.is_file() else None


def render(config_path: Path, work_dir: Path) -> Path:
    total_steps = 6

    _log(1, total_steps, "Load asset — reading job config")
    job = json.loads(config_path.read_text(encoding="utf-8"))
    spec = job.get("spec") or {}
    engine_config = job.get("engineConfig") or {}

    assets_raw = job.get("assetsDir") or spec.get("assetsDir") or config_path.parent
    assets_dir = Path(str(assets_raw))
    if not assets_dir.is_absolute():
        assets_dir = (config_path.parent / assets_dir).resolve()

    config = RenderConfig.from_dict(engine_config)

    left = spec.get("left") or {}
    right = spec.get("right") or {}
    background_path = _resolve_asset(spec.get("background"), assets_dir)
    left_image_path = _resolve_asset(left.get("image"), assets_dir)
    right_image_path = _resolve_asset(right.get("image"), assets_dir)
    voice_path = _resolve_asset(spec.get("voice"), assets_dir)

    _log(2, total_steps, "Build timeline from scenes")
    timeline = Timeline.from_spec(spec)
    if not timeline.scenes:
        raise ValueError("spec.scenes must contain at least one scene")

    output_dir = work_dir / "output"
    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / "short_video.mp4"

    _log(3, total_steps, "Build subtitle (ASS)")
    ass_path = build_ass(
        timeline,
        str(left.get("title") or ""),
        str(right.get("title") or ""),
        config,
        config.layout(),
        work_dir / "subtitles.ass",
    )

    _log(4, total_steps, "Compose FFmpeg builder")
    builder = (
        FFmpegBuilder(config, work_dir)
        .background(background_path)
        .leftImage(left_image_path)
        .rightImage(right_image_path)
        .titles(str(left.get("title") or ""), str(right.get("title") or ""))
        .dragon(timeline, DRAGON_ASSETS_DIR)
        .subtitle(ass_path)
        .audio(voice_path)
    )

    _log(5, total_steps, f"Render {config.width}x{config.height} @ {config.fps}fps")
    builder.export(out_path)

    _log(6, total_steps, "Finalize")
    return out_path.resolve()


def main() -> None:
    parser = argparse.ArgumentParser(description="ShortVideo render engine")
    parser.add_argument("--config", required=True, help="Path to job_config.json")
    parser.add_argument("--work-dir", default=None, help="Working directory for outputs")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    work_dir = Path(args.work_dir).resolve() if args.work_dir else config_path.parent
    work_dir.mkdir(parents=True, exist_ok=True)

    try:
        out_path = render(config_path, work_dir)
    except Exception as exc:  # noqa: BLE001 - surface message to the Node processor
        print(f"[SHORTVIDEO_FAILED] {exc}", flush=True)
        sys.exit(1)

    print(f"DONE: {out_path}", flush=True)


if __name__ == "__main__":
    main()
