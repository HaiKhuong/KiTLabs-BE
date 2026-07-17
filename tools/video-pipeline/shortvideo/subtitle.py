"""Generate an ASS subtitle track (titles + per-scene subtitles) for libass burn-in.

Using ASS keeps Unicode / Vietnamese text rendering reliable via libass, and lets
titles and subtitles share one timed text layer.
"""

from __future__ import annotations

from pathlib import Path

from .config import RenderConfig
from .timeline import Timeline


def _fmt_time(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = seconds % 60
    return f"{hours:d}:{minutes:02d}:{secs:05.2f}"


def _escape(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\n", "\\N")
    )


def _center(region: dict[str, int]) -> tuple[int, int]:
    return region["x"] + region["w"] // 2, region["y"] + region["h"] // 2


def build_ass(
    timeline: Timeline,
    left_title: str,
    right_title: str,
    config: RenderConfig,
    layout: dict[str, dict[str, int]],
    out_path: Path,
) -> Path:
    total = timeline.total_duration or sum(s.duration for s in timeline.scenes) or 1.0
    font = config.font or "Arial"

    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {config.width}
PlayResY: {config.height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,{font},{config.title_font_size},&H00FFFFFF,&H000000FF,&H00202020,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,5,10,10,10,1
Style: Sub,{font},{config.subtitle_font_size},&H00FFFFFF,&H000000FF,&H00202020,&H96000000,-1,0,0,0,100,100,0,0,1,4,2,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines: list[str] = []

    def _dialogue(style: str, start: float, end: float, region_key: str, text: str) -> None:
        if not text:
            return
        cx, cy = _center(layout[region_key])
        payload = f"{{\\pos({cx},{cy})}}{_escape(text)}"
        lines.append(
            f"Dialogue: 0,{_fmt_time(start)},{_fmt_time(end)},{style},,0,0,0,,{payload}"
        )

    def _title(region_key: str, text: str) -> None:
        """Anchor the title on the top edge of its image column (top-center)."""
        if not text:
            return
        region = layout[region_key]
        cx = region["x"] + region["w"] // 2
        y = region["y"] + max(10, config.safe_margin // 4)
        payload = f"{{\\an8\\pos({cx},{y})}}{_escape(text)}"
        lines.append(
            f"Dialogue: 0,{_fmt_time(0.0)},{_fmt_time(total)},Title,,0,0,0,,{payload}"
        )

    _title("titleLeft", left_title)
    _title("titleRight", right_title)

    for caption in timeline.captions:
        _dialogue("Sub", caption.start, caption.end, "subtitle", caption.text)

    out_path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    return out_path
