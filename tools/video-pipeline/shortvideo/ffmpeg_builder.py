"""FFmpegBuilder — Builder Pattern for composing the ShortVideo filter graph.

No command is hardcoded: each `.background() .leftImage() .rightImage() .titles()
.dragon() .subtitle() .audio()` call accumulates inputs + filter state, and
`.export()` assembles the final argument list and runs FFmpeg.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from typing import Any

from .config import RenderConfig
from .timeline import Timeline

FFMPEG_BIN = (os.getenv("FFMPEG_BIN") or "ffmpeg").strip() or "ffmpeg"


class FFmpegBuilder:
    def __init__(self, config: RenderConfig, work_dir: Path) -> None:
        self.config = config
        self.work_dir = work_dir
        self.layout = config.layout()

        self._background: dict[str, Any] | None = None
        self._left: dict[str, Any] | None = None
        self._right: dict[str, Any] | None = None
        self._left_title = ""
        self._right_title = ""
        self._dragon: list[dict[str, Any]] = []
        self._ass_name: str | None = None
        self._audio_path: Path | None = None
        self._timeline: Timeline | None = None

    # -- Builder steps -----------------------------------------------------

    def background(self, path: Path | None) -> "FFmpegBuilder":
        self._background = self._image_or_color(
            path, self.config.width, self.config.height, self.config.background_color
        )
        return self

    def leftImage(self, path: Path | None) -> "FFmpegBuilder":
        r = self.layout["imageLeft"]
        self._left = self._image_or_color(path, r["w"], r["h"], self.config.placeholder_left_color)
        return self

    def rightImage(self, path: Path | None) -> "FFmpegBuilder":
        r = self.layout["imageRight"]
        self._right = self._image_or_color(
            path, r["w"], r["h"], self.config.placeholder_right_color
        )
        return self

    def titles(self, left_title: str, right_title: str) -> "FFmpegBuilder":
        self._left_title = left_title or ""
        self._right_title = right_title or ""
        return self

    def dragon(self, timeline: Timeline, assets_dir: Path) -> "FFmpegBuilder":
        self._timeline = timeline
        r = self.layout["dragon"]
        for pose in timeline.poses():
            path = assets_dir / f"{pose}.png"
            spec = self._image_or_color(
                path if path.is_file() else None, min(r["w"], 520), min(r["h"], 520), "0x00000000"
            )
            spec["intervals"] = timeline.intervals_for_pose(pose)
            self._dragon.append(spec)
        return self

    def subtitle(self, ass_path: Path | None) -> "FFmpegBuilder":
        self._ass_name = ass_path.name if ass_path else None
        return self

    def audio(self, path: Path | None) -> "FFmpegBuilder":
        self._audio_path = path if path and path.is_file() else None
        return self

    # -- Assembly / run ----------------------------------------------------

    def export(self, out_path: Path) -> Path:
        cfg = self.config
        w, h, fps = cfg.width, cfg.height, cfg.fps
        total = (self._timeline.total_duration if self._timeline else 0.0) or 5.0

        input_args: list[str] = []
        index = 0

        def add_input(spec: dict[str, Any]) -> int:
            nonlocal index
            if spec["kind"] == "image":
                input_args.extend(["-loop", "1", "-i", str(spec["path"])])
            else:
                input_args.extend(
                    ["-f", "lavfi", "-i", f"color=c={spec['color']}:s={spec['w']}x{spec['h']}:r={fps}"]
                )
            current = index
            index += 1
            return current

        bg_i = add_input(self._background or self._image_or_color(None, w, h, cfg.background_color))
        left_i = add_input(self._left or self._image_or_color(None, 400, 400, cfg.placeholder_left_color))
        right_i = add_input(
            self._right or self._image_or_color(None, 400, 400, cfg.placeholder_right_color)
        )
        dragon_indices = [(add_input(spec), spec) for spec in self._dragon]

        if self._audio_path:
            input_args.extend(["-i", str(self._audio_path)])
        else:
            input_args.extend(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"])
        audio_i = index
        index += 1

        chains: list[str] = []
        li, ri = self.layout["imageLeft"], self.layout["imageRight"]
        dr = self.layout["dragon"]

        chains.append(
            f"[{bg_i}:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1,fps={fps}[bg]"
        )
        chains.append(
            f"[{left_i}:v]scale={li['w']}:{li['h']}:force_original_aspect_ratio=decrease,setsar=1[limg]"
        )
        chains.append(
            f"[{right_i}:v]scale={ri['w']}:{ri['h']}:force_original_aspect_ratio=decrease,setsar=1[rimg]"
        )
        chains.append(
            f"[bg][limg]overlay=x={li['x']}+({li['w']}-overlay_w)/2:"
            f"y={li['y']}+({li['h']}-overlay_h)/2[b1]"
        )
        chains.append(
            f"[b1][rimg]overlay=x={ri['x']}+({ri['w']}-overlay_w)/2:"
            f"y={ri['y']}+({ri['h']}-overlay_h)/2[b2]"
        )

        cursor = "b2"
        for n, (idx, spec) in enumerate(dragon_indices):
            chains.append(
                f"[{idx}:v]scale={min(dr['w'], 520)}:{min(dr['h'], 520)}:"
                f"force_original_aspect_ratio=decrease,setsar=1[d{n}s]"
            )
            enable = "+".join(f"between(t,{s},{e})" for s, e in spec["intervals"]) or "0"
            nxt = f"d{n}o"
            chains.append(
                f"[{cursor}][d{n}s]overlay=x={dr['x']}+({dr['w']}-overlay_w)/2:"
                f"y={dr['y']}+{dr['h']}-overlay_h:enable='{enable}'[{nxt}]"
            )
            cursor = nxt

        box_i = 0
        if self._timeline:
            for scene in self._timeline.scenes:
                for side in ("highlight", "zoom"):
                    which = getattr(scene, side)
                    if which not in ("left", "right"):
                        continue
                    region = li if which == "left" else ri
                    thickness = 16 if side == "zoom" else 8
                    nxt = f"box{box_i}"
                    chains.append(
                        f"[{cursor}]drawbox=x={region['x']}:y={region['y']}:"
                        f"w={region['w']}:h={region['h']}:"
                        f"color={cfg.highlight_color}@0.9:t={thickness}:"
                        f"enable='between(t,{scene.start},{scene.end})'[{nxt}]"
                    )
                    cursor = nxt
                    box_i += 1

        if self._ass_name:
            chains.append(f"[{cursor}]subtitles={self._ass_name}[vout]")
            video_label = "vout"
        else:
            video_label = cursor

        filter_complex = ";".join(chains)

        cmd = [
            FFMPEG_BIN,
            "-y",
            *input_args,
            "-filter_complex",
            filter_complex,
            "-map",
            f"[{video_label}]",
            "-map",
            f"{audio_i}:a",
            "-t",
            f"{total:.3f}",
            "-r",
            str(fps),
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-pix_fmt",
            "yuv420p",
            "-b:v",
            cfg.bitrate,
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(out_path),
        ]

        proc = subprocess.run(cmd, cwd=str(self.work_dir), capture_output=True, text=True)
        if proc.returncode != 0:
            err = (proc.stderr or proc.stdout or "").strip()
            raise RuntimeError(f"FFmpeg render failed: {err[-3000:]}")
        return out_path

    # -- Helpers -----------------------------------------------------------

    @staticmethod
    def _image_or_color(path: Path | None, w: int, h: int, color: str) -> dict[str, Any]:
        if path and Path(path).is_file():
            return {"kind": "image", "path": Path(path)}
        return {"kind": "color", "color": color, "w": max(2, int(w)), "h": max(2, int(h))}
