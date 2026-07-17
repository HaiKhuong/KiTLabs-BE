"""Render configuration + layout math for the ShortVideo engine.

All tunables (Video Width/Height, FPS, Bitrate, Font, Font Size, Safe Margin,
Dragon Position, Subtitle Position, Title Position) live here so the FFmpeg
builder never hardcodes numbers.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _as_int(value: Any, fallback: int) -> int:
    try:
        if value is None or value == "":
            return fallback
        return int(round(float(value)))
    except (TypeError, ValueError):
        return fallback


def _as_float(value: Any, fallback: float) -> float:
    try:
        if value is None or value == "":
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _as_str(value: Any, fallback: str) -> str:
    if value is None:
        return fallback
    text = str(value).strip()
    return text or fallback


@dataclass
class RenderConfig:
    # Video
    width: int = 1080
    height: int = 1920
    fps: int = 30
    bitrate: str = "8M"

    # Text
    font: str = "Arial"
    font_file: str | None = None
    font_size: int = 60
    title_font_size: int = 72
    subtitle_font_size: int = 60

    # Layout
    safe_margin: int = 60
    # Named positions kept for clarity / future overrides.
    title_position: str = "top"
    subtitle_position: str = "center"
    dragon_position: str = "bottom-center"

    # Colours (0xRRGGBB / 0xAARRGGBB for lavfi)
    background_color: str = "0x0B1021"
    placeholder_left_color: str = "0x1E3A8A"
    placeholder_right_color: str = "0x0E7490"
    highlight_color: str = "0xF59E0B"

    # Focus effect: focused column zooms in slightly, the other is dimmed.
    focus_zoom: float = 1.12  # scale factor of the focused column (1.0 = off)
    focus_dim: float = 0.45  # black overlay opacity on the non-focused column

    extra: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "RenderConfig":
        data = data or {}
        cfg = cls()
        cfg.width = _as_int(data.get("width"), cfg.width)
        cfg.height = _as_int(data.get("height"), cfg.height)
        cfg.fps = _as_int(data.get("fps"), cfg.fps)
        cfg.bitrate = _as_str(data.get("bitrate"), cfg.bitrate)
        cfg.font = _as_str(data.get("font"), cfg.font)
        raw_font_file = data.get("fontFile") or data.get("font_file")
        cfg.font_file = str(raw_font_file).strip() if raw_font_file else None
        cfg.font_size = _as_int(data.get("fontSize") or data.get("font_size"), cfg.font_size)
        cfg.title_font_size = _as_int(
            data.get("titleFontSize") or data.get("title_font_size"), cfg.title_font_size
        )
        cfg.subtitle_font_size = _as_int(
            data.get("subtitleFontSize") or data.get("subtitle_font_size"),
            cfg.subtitle_font_size or cfg.font_size,
        )
        cfg.safe_margin = _as_int(data.get("safeMargin") or data.get("safe_margin"), cfg.safe_margin)
        cfg.title_position = _as_str(
            data.get("titlePosition") or data.get("title_position"), cfg.title_position
        )
        cfg.subtitle_position = _as_str(
            data.get("subtitlePosition") or data.get("subtitle_position"), cfg.subtitle_position
        )
        cfg.dragon_position = _as_str(
            data.get("dragonPosition") or data.get("dragon_position"), cfg.dragon_position
        )
        cfg.background_color = _as_str(
            data.get("backgroundColor") or data.get("background_color"), cfg.background_color
        )
        cfg.highlight_color = _as_str(
            data.get("highlightColor") or data.get("highlight_color"), cfg.highlight_color
        )
        cfg.focus_zoom = max(
            1.0, min(2.0, _as_float(data.get("focusZoom") or data.get("focus_zoom"), cfg.focus_zoom))
        )
        cfg.focus_dim = max(
            0.0, min(1.0, _as_float(data.get("focusDim") or data.get("focus_dim"), cfg.focus_dim))
        )
        cfg.extra = {k: v for k, v in data.items()}
        return cfg

    def layout(self) -> dict[str, dict[str, int]]:
        """Compute pixel rectangles for each region of the 9:16 layout.

        Rows (top -> bottom): two image columns (titles overlaid on their top
        edge) | subtitle band | dragon band.
        """
        w, h, m = self.width, self.height, self.safe_margin

        # Images start near the top; the title sits on top of each image.
        img_y = m
        col_w = (w - 3 * m) // 2
        col_h = int(h * 0.34)
        left_x = m
        right_x = m * 2 + col_w

        # Title strip overlaid on the upper part of each image column.
        title_h = max(90, int(h * 0.06))

        sub_y = img_y + col_h + m
        sub_h = int(h * 0.18)

        dragon_y = sub_y + sub_h + m // 2
        dragon_h = max(200, h - dragon_y - m)
        dragon_w = w - 2 * m
        dragon_x = m

        return {
            "canvas": {"x": 0, "y": 0, "w": w, "h": h},
            "titleLeft": {"x": left_x, "y": img_y, "w": col_w, "h": title_h},
            "titleRight": {"x": right_x, "y": img_y, "w": col_w, "h": title_h},
            "imageLeft": {"x": left_x, "y": img_y, "w": col_w, "h": col_h},
            "imageRight": {"x": right_x, "y": img_y, "w": col_w, "h": col_h},
            "subtitle": {"x": m, "y": sub_y, "w": w - 2 * m, "h": sub_h},
            "dragon": {"x": dragon_x, "y": dragon_y, "w": dragon_w, "h": dragon_h},
        }
