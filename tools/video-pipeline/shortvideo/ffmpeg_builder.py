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
        self._sfx_path: Path | None = None
        self._transition_times: list[float] = []

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
        # Dragon poses are transparent PNGs — only overlay poses that actually exist
        # (skip missing files so we never composite an opaque placeholder box).
        for pose in timeline.poses():
            path = assets_dir / f"{pose}.png"
            if not path.is_file():
                continue
            spec = {"kind": "image", "path": path}
            spec["intervals"] = timeline.intervals_for_pose(pose)
            self._dragon.append(spec)
        return self

    def subtitle(self, ass_path: Path | None) -> "FFmpegBuilder":
        self._ass_name = ass_path.name if ass_path else None
        return self

    def audio(self, path: Path | None) -> "FFmpegBuilder":
        self._audio_path = path if path and path.is_file() else None
        return self

    def transitions(self, times: list[float], sfx_path: Path | None) -> "FFmpegBuilder":
        """Play a sound effect at each timestamp (dragon pose changes)."""
        self._sfx_path = sfx_path if sfx_path and sfx_path.is_file() else None
        self._transition_times = [max(0.0, float(t)) for t in (times or [])]
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

        sfx_i: int | None = None
        if self._sfx_path and self._transition_times:
            input_args.extend(["-i", str(self._sfx_path)])
            sfx_i = index
            index += 1

        chains: list[str] = []
        li, ri = self.layout["imageLeft"], self.layout["imageRight"]

        chains.append(
            f"[{bg_i}:v]scale={w}:{h}:force_original_aspect_ratio=increase,"
            f"crop={w}:{h},setsar=1,fps={fps}[bg]"
        )
        # Focus effect intervals (per column).
        left_focus = self._timeline.intervals_for_focus("left") if self._timeline else []
        right_focus = self._timeline.intervals_for_focus("right") if self._timeline else []
        zf = cfg.focus_zoom
        dim = cfg.focus_dim

        def _enable(intervals: list[tuple[float, float]]) -> str:
            return "+".join(f"between(t,{s},{e})" for s, e in intervals) or "0"

        # Left column: base (fit) + optional zoomed copy (fill+crop) used while focused.
        left_zoomed = bool(left_focus) and zf > 1.0
        if left_zoomed:
            chains.append(f"[{left_i}:v]split=2[lsrc][lzsrc]")
            chains.append(
                f"[lzsrc]scale={int(li['w'] * zf)}:{int(li['h'] * zf)}:"
                f"force_original_aspect_ratio=increase,crop={li['w']}:{li['h']},setsar=1[lzoom]"
            )
            left_src = "lsrc"
        else:
            left_src = f"{left_i}:v"
        chains.append(
            f"[{left_src}]scale={li['w']}:{li['h']}:force_original_aspect_ratio=increase,"
            f"crop={li['w']}:{li['h']},setsar=1[limg]"
        )

        right_zoomed = bool(right_focus) and zf > 1.0
        if right_zoomed:
            chains.append(f"[{right_i}:v]split=2[rsrc][rzsrc]")
            chains.append(
                f"[rzsrc]scale={int(ri['w'] * zf)}:{int(ri['h'] * zf)}:"
                f"force_original_aspect_ratio=increase,crop={ri['w']}:{ri['h']},setsar=1[rzoom]"
            )
            right_src = "rsrc"
        else:
            right_src = f"{right_i}:v"
        chains.append(
            f"[{right_src}]scale={ri['w']}:{ri['h']}:force_original_aspect_ratio=increase,"
            f"crop={ri['w']}:{ri['h']},setsar=1[rimg]"
        )

        chains.append(f"[bg][limg]overlay=x={li['x']}:y={li['y']}[b1]")
        chains.append(f"[b1][rimg]overlay=x={ri['x']}:y={ri['y']}[b2]")

        cursor = "b2"
        fx = 0

        # Zoom the focused column (magnified copy sits on top during its intervals).
        if left_zoomed:
            nxt = f"fx{fx}"
            chains.append(
                f"[{cursor}][lzoom]overlay=x={li['x']}:y={li['y']}:"
                f"enable='{_enable(left_focus)}'[{nxt}]"
            )
            cursor = nxt
            fx += 1
        if right_zoomed:
            nxt = f"fx{fx}"
            chains.append(
                f"[{cursor}][rzoom]overlay=x={ri['x']}:y={ri['y']}:"
                f"enable='{_enable(right_focus)}'[{nxt}]"
            )
            cursor = nxt
            fx += 1

        # Dim the non-focused column (black overlay while the other side is focused).
        if dim > 0.0 and left_focus:  # left focused -> dim right
            nxt = f"fx{fx}"
            chains.append(
                f"[{cursor}]drawbox=x={ri['x']}:y={ri['y']}:w={ri['w']}:h={ri['h']}:"
                f"color=black@{dim}:t=fill:enable='{_enable(left_focus)}'[{nxt}]"
            )
            cursor = nxt
            fx += 1
        if dim > 0.0 and right_focus:  # right focused -> dim left
            nxt = f"fx{fx}"
            chains.append(
                f"[{cursor}]drawbox=x={li['x']}:y={li['y']}:w={li['w']}:h={li['h']}:"
                f"color=black@{dim}:t=fill:enable='{_enable(right_focus)}'[{nxt}]"
            )
            cursor = nxt
            fx += 1

        # Dragon: scale to 70% of the frame width, keep native aspect ratio,
        # centered horizontally and anchored to the bottom safe margin.
        dragon_w = int(w * 0.7)
        for n, (idx, spec) in enumerate(dragon_indices):
            chains.append(f"[{idx}:v]scale={dragon_w}:-2,format=rgba,setsar=1[d{n}s]")
            enable = "+".join(f"between(t,{s},{e})" for s, e in spec["intervals"]) or "0"
            nxt = f"d{n}o"
            chains.append(
                f"[{cursor}][d{n}s]overlay=x=(main_w-overlay_w)/2:"
                f"y=main_h-overlay_h-{cfg.safe_margin}:enable='{enable}'[{nxt}]"
            )
            cursor = nxt

        if self._ass_name:
            chains.append(f"[{cursor}]subtitles={self._ass_name}[vout]")
            video_label = "vout"
        else:
            video_label = cursor

        # Mix a transition SFX at each pose-change timestamp on top of the voice.
        audio_map = f"{audio_i}:a"
        if sfx_i is not None:
            n = len(self._transition_times)
            vol = cfg.sfx_volume
            chains.append(
                f"[{sfx_i}:a]asplit={n}" + "".join(f"[sfxsrc{k}]" for k in range(n))
            )
            sfx_labels: list[str] = []
            for k, t in enumerate(self._transition_times):
                ms = int(round(t * 1000))
                chains.append(
                    f"[sfxsrc{k}]adelay={ms}|{ms},volume={vol}[sfxd{k}]"
                )
                sfx_labels.append(f"[sfxd{k}]")
            mix_inputs = f"[{audio_i}:a]" + "".join(sfx_labels)
            chains.append(
                f"{mix_inputs}amix=inputs={n + 1}:duration=first:"
                f"dropout_transition=0:normalize=0[aout]"
            )
            audio_map = "[aout]"

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
            audio_map,
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
