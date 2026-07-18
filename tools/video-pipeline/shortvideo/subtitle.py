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


def _wrap_title(text: str, region_width: int, font_size: int) -> str:
    """Wrap a title to at most two balanced lines within its column."""
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return ""

    # Approximate bold font width; libass performs the final glyph rendering.
    usable_width = max(1, region_width - 20)
    estimated_width = len(normalized) * max(1, font_size) * 0.56
    if estimated_width <= usable_width:
        return normalized

    words = normalized.split()
    if len(words) == 1:
        midpoint = max(1, len(normalized) // 2)
        return f"{normalized[:midpoint]}\n{normalized[midpoint:]}"

    # Pick the word boundary that minimizes the wider of the two lines.
    best_left, best_right = words[0], " ".join(words[1:])
    best_score = max(len(best_left), len(best_right))
    for index in range(1, len(words)):
        left = " ".join(words[:index])
        right = " ".join(words[index:])
        score = max(len(left), len(right))
        if score < best_score:
            best_left, best_right, best_score = left, right, score
    return f"{best_left}\n{best_right}"


def _sub_effect(style: str, cx: int, cy: int) -> str:
    """Per-caption ASS override tags implementing a subtitle animation preset.

    `\\t` / `\\move` / `\\fad` timings are relative to each caption line's start,
    and each caption is its own Dialogue line, so the effect replays per chunk.
    Scaling uses the style's center alignment so the text pops from its center.
    """
    s = (style or "pop").strip().lower()
    if s in ("none", "plain", "static", "off"):
        return f"\\pos({cx},{cy})"
    if s == "fade":
        return f"\\pos({cx},{cy})\\fad(180,120)"
    if s in ("slide", "slideup", "slide-up", "fadeslide"):
        return f"\\move({cx},{cy + 60},{cx},{cy},0,220)\\fad(150,90)"
    # Default: pop bounce (TikTok) — spring in from 55% with a slight overshoot.
    return (
        f"\\pos({cx},{cy})\\fad(80,50)"
        f"\\fscx55\\fscy55"
        f"\\t(0,120,\\fscx113\\fscy113)"
        f"\\t(120,210,\\fscx100\\fscy100)"
    )


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
Style: Title,{font},{config.title_font_size},&H000000FF,&H000000FF,&H00202020,&H96000000,-1,0,0,0,100,100,0,0,1,3,1,5,10,10,10,1
Style: Sub,{font},{config.subtitle_font_size},&H00FFFFFF,&H000000FF,&H00000000,&H96000000,-1,0,0,0,100,100,0,0,1,6,3,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""

    lines: list[str] = []

    def _dialogue(style: str, start: float, end: float, region_key: str, text: str) -> None:
        if not text:
            return
        cx, cy = _center(layout[region_key])
        payload = f"{{{_sub_effect(config.subtitle_style, cx, cy)}}}{_escape(text)}"
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
        wrapped = _wrap_title(text, region["w"], config.title_font_size)
        payload = f"{{\\an8\\pos({cx},{y})}}{_escape(wrapped)}"
        lines.append(
            f"Dialogue: 0,{_fmt_time(0.0)},{_fmt_time(total)},Title,,0,0,0,,{payload}"
        )

    _title("titleLeft", left_title)
    _title("titleRight", right_title)

    for caption in timeline.captions:
        _dialogue("Sub", caption.start, caption.end, "subtitle", caption.text)

    out_path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")
    return out_path
