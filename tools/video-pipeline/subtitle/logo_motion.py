"""FFmpeg overlay x/y expressions for animated logo watermarks."""

from __future__ import annotations

LOGO_MOTIONS = ("static", "rtl", "diagonal", "bounce")
DIAGONAL_Y_SPEED_RATIO = 0.65
BOUNCE_Y_SPEED_RATIO = 0.618
# Bounce: điểm bắt đầu ~25% khung; biên độ vẫn full (0 … W-w / H-h).
BOUNCE_START_X_FRAC = 0.25
BOUNCE_START_Y_FRAC = 0.25


def _esc(expr: str) -> str:
    """Escape commas so overlay expressions stay one filtergraph argument."""
    return expr.replace(",", "\\,")


def normalize_logo_motion(value: str | None) -> str:
    motion = (value or "static").strip().lower()
    return motion if motion in LOGO_MOTIONS else "static"


def normalize_overlay_text_motion(value: str | None) -> str:
    motion = (value or "rtl").strip().lower()
    if motion in ("rtl", "diagonal", "bounce", "static"):
        return motion
    return "rtl"


def clamp_logo_speed(speed_px_s: float) -> float:
    return max(1.0, min(2000.0, float(speed_px_s)))


def logo_overlay_xy_expr(
    motion: str,
    speed_px_s: float,
    margin_x: int,
    margin_y: int,
) -> tuple[str, str]:
    """Return overlay x/y expressions (commas already escaped)."""
    motion = normalize_logo_motion(motion)
    mx = int(margin_x)
    my = int(margin_y)
    if motion == "static":
        return str(mx), str(my)

    speed = clamp_logo_speed(speed_px_s)
    sp = f"{speed:.4f}"
    if motion == "rtl":
        # Enter from the right, wrap after leaving the left edge.
        return _esc(f"W-mod(t*{sp},W+w)"), str(my)
    if motion == "diagonal":
        ysp = f"{speed * DIAGONAL_Y_SPEED_RATIO:.4f}"
        return (
            _esc(f"W-mod(t*{sp},W+w)"),
            _esc(f"H-mod(t*{ysp},H+h)"),
        )
    # bounce: triangle wave full frame; phase offset → bắt đầu ~25% W/H.
    ysp = f"{speed * BOUNCE_Y_SPEED_RATIO:.4f}"
    rx = "max(W-w\\,1)"
    ry = "max(H-h\\,1)"
    sx = f"{BOUNCE_START_X_FRAC}*W"
    sy = f"{BOUNCE_START_Y_FRAC}*H"
    return (
        _esc(f"abs(mod(t*{sp}+{rx}+{sx},2*{rx})-{rx})"),
        _esc(f"abs(mod(t*{ysp}+{ry}+{sy},2*{ry})-{ry})"),
    )


def build_logo_overlay_filter(
    main_pad: str,
    logo_pad: str,
    out_pad: str,
    motion: str,
    speed_px_s: float,
    margin_x: int,
    margin_y: int,
) -> str:
    x_expr, y_expr = logo_overlay_xy_expr(motion, speed_px_s, margin_x, margin_y)
    return f"{main_pad}{logo_pad}overlay=x='{x_expr}':y='{y_expr}'{out_pad}"
