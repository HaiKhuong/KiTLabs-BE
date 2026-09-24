"""FFmpeg overlay x/y expressions for animated logo watermarks."""

from __future__ import annotations

import math

LOGO_MOTIONS = ("static", "rtl", "diagonal", "bounce")
DIAGONAL_Y_SPEED_RATIO = 0.65
BOUNCE_Y_SPEED_RATIO = 0.618
# Bounce: điểm bắt đầu ~25% khung; biên độ vẫn full (0 … W-w / H-h).
BOUNCE_START_X_FRAC = 0.25
BOUNCE_START_Y_FRAC = 0.0
OVERLAY_BOUNCE_T_MAX = 4 * 3600.0
OVERLAY_BOUNCE_SEGMENTS = 24


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


def _unit_hash(idx_expr: str, salt: float) -> str:
    """Deterministic 0..1 from an integer-valued FFmpeg expr (stable within a lap/segment)."""
    return f"mod(sin(({idx_expr})*{salt:.6f})*43758.5453,1)"


def _edge_point_xy(seg_expr: str, rx: str, ry: str, salt_side: float, salt_along: float) -> tuple[str, str]:
    """Random point on the frame rectangle edge (0 top, 1 right, 2 bottom, 3 left)."""
    side = f"floor({_unit_hash(seg_expr, salt_side)}*4)"
    along = _unit_hash(seg_expr, salt_along)
    x = f"if(eq({side},0),{along}*{rx},if(eq({side},1),{rx},if(eq({side},2),{along}*{rx},0)))"
    y = f"if(eq({side},0),0,if(eq({side},1),{along}*{ry},if(eq({side},2),{ry},{along}*{ry})))"
    return x, y


def _overlay_unit_hash_n(n: int, salt: float) -> float:
    return (math.sin(n * salt) * 43758.5453) % 1.0


def _overlay_bounce_outgoing(side: int, seg: int, speed: float) -> tuple[float, float]:
    """Velocity after hitting an edge. Angle from the wall is always > 45°."""
    deg = 45.05 + _overlay_unit_hash_n(seg, 12.9898) * 44.9
    rad = math.radians(deg)
    along = 1.0 if _overlay_unit_hash_n(seg, 78.233) >= 0.5 else -1.0
    perp = math.sin(rad) * speed
    par = math.cos(rad) * speed * along
    if side == 0:
        return par, perp
    if side == 1:
        return -perp, par
    if side == 2:
        return par, -perp
    return perp, par


def _overlay_bounce_start(rx: float, ry: float, frame_w: float, frame_h: float) -> tuple[float, float]:
    x = min(max(BOUNCE_START_X_FRAC * frame_w, 0.0), rx)
    y = min(max(BOUNCE_START_Y_FRAC * frame_h, 0.0), ry)
    return x, y


def overlay_bounce_pos(
    t_sec: float,
    speed: float,
    rx: float,
    ry: float,
    frame_w: float,
    frame_h: float,
) -> tuple[float, float]:
    """Position inside the frame at t; billiard bounce, random angle > 45° on each edge."""
    speed = clamp_logo_speed(speed)
    rx = max(float(rx), 1.0)
    ry = max(float(ry), 1.0)
    t_sec = max(0.0, float(t_sec))
    x, y = _overlay_bounce_start(rx, ry, frame_w, frame_h)
    vx, vy = _overlay_bounce_outgoing(0, 0, speed)
    elapsed = 0.0
    seg = 0
    eps = 1e-6
    while elapsed < t_sec and seg < 20000:
        tx = (rx - x) / vx if vx > eps else ((0.0 - x) / vx if vx < -eps else float("inf"))
        ty = (ry - y) / vy if vy > eps else ((0.0 - y) / vy if vy < -eps else float("inf"))
        if tx < 0:
            tx = float("inf")
        if ty < 0:
            ty = float("inf")
        dt = min(tx, ty)
        if not math.isfinite(dt) or dt <= eps:
            vx, vy = _overlay_bounce_outgoing(seg % 4, seg + 1, speed)
            seg += 1
            continue
        remain = t_sec - elapsed
        if dt >= remain:
            return x + vx * remain, y + vy * remain
        x += vx * dt
        y += vy * dt
        elapsed += dt
        hit_v = tx <= ty
        if hit_v:
            side = 1 if vx > 0 else 3
            x = rx if vx > 0 else 0.0
        else:
            side = 2 if vy > 0 else 0
            y = ry if vy > 0 else 0.0
        x = min(max(x, 0.0), rx)
        y = min(max(y, 0.0), ry)
        vx, vy = _overlay_bounce_outgoing(side, seg + 1, speed)
        seg += 1
    return min(max(x, 0.0), rx), min(max(y, 0.0), ry)


def iter_overlay_bounce_segments(
    speed: float,
    rx: float,
    ry: float,
    frame_w: float,
    frame_h: float,
    t_max: float,
):
    speed = clamp_logo_speed(speed)
    rx = max(float(rx), 1.0)
    ry = max(float(ry), 1.0)
    x, y = _overlay_bounce_start(rx, ry, frame_w, frame_h)
    vx, vy = _overlay_bounce_outgoing(0, 0, speed)
    elapsed = 0.0
    seg = 0
    eps = 1e-6
    t_max = max(1.0, float(t_max))
    while elapsed < t_max and seg < 20000:
        x0, y0, t0 = x, y, elapsed
        tx = (rx - x) / vx if vx > eps else ((0.0 - x) / vx if vx < -eps else float("inf"))
        ty = (ry - y) / vy if vy > eps else ((0.0 - y) / vy if vy < -eps else float("inf"))
        if tx < 0:
            tx = float("inf")
        if ty < 0:
            ty = float("inf")
        dt = min(tx, ty)
        if not math.isfinite(dt) or dt <= eps:
            vx, vy = _overlay_bounce_outgoing(seg % 4, seg + 1, speed)
            seg += 1
            continue
        dt = min(dt, t_max - elapsed)
        x1 = x + vx * dt
        y1 = y + vy * dt
        t1 = elapsed + dt
        yield t0, t1, x0, y0, x1, y1
        x, y, elapsed = x1, y1, t1
        if elapsed >= t_max:
            break
        hit_v = tx <= ty
        if hit_v:
            side = 1 if vx > 0 else 3
            x = rx if vx > 0 else 0.0
        else:
            side = 2 if vy > 0 else 0
            y = ry if vy > 0 else 0.0
        x = min(max(x, 0.0), rx)
        y = min(max(y, 0.0), ry)
        vx, vy = _overlay_bounce_outgoing(side, seg + 1, speed)
        seg += 1


def _bounce_lerp_expr(speed: float, frame_w: int, frame_h: int, overlay_w: int, overlay_h: int) -> tuple[str, str]:
    rx = max(frame_w - overlay_w, 1)
    ry = max(frame_h - overlay_h, 1)
    segs = []
    for item in iter_overlay_bounce_segments(speed, rx, ry, frame_w, frame_h, OVERLAY_BOUNCE_T_MAX):
        segs.append(item)
        if len(segs) >= OVERLAY_BOUNCE_SEGMENTS:
            break
    if not segs:
        return "0", "0"
    t0, t1, x0, y0, x1, y1 = segs[-1]
    start_x, start_y = _overlay_bounce_start(rx, ry, frame_w, frame_h)
    close_dist = math.hypot(start_x - x1, start_y - y1)
    close_dt = max(close_dist / max(speed, 1.0), 0.12)
    segs.append((t1, t1 + close_dt, x1, y1, start_x, start_y))
    period = segs[-1][1]
    if period <= 0:
        return "0", "0"
    tt = f"mod(t,{period:.4f})"
    parts_x: list[str] = []
    parts_y: list[str] = []
    for s_t0, s_t1, s_x0, s_y0, s_x1, s_y1 in segs:
        dt = max(s_t1 - s_t0, 1e-6)
        parts_x.append(
            f"({s_x0:.3f}+({s_x1:.3f}-{s_x0:.3f})*({tt}-{s_t0:.4f})/{dt:.4f})*between({tt},{s_t0:.4f},{s_t1:.4f})"
        )
        parts_y.append(
            f"({s_y0:.3f}+({s_y1:.3f}-{s_y0:.3f})*({tt}-{s_t0:.4f})/{dt:.4f})*between({tt},{s_t0:.4f},{s_t1:.4f})"
        )
    return _esc("+".join(parts_x)), _esc("+".join(parts_y))


def overlay_text_overlay_xy_expr(
    motion: str,
    speed_px_s: float,
    margin_x: int,
    margin_y: int,
    frame_w: int | None = None,
    frame_h: int | None = None,
    overlay_w: int | None = None,
    overlay_h: int | None = None,
) -> tuple[str, str]:
    """Ticker motion: new random lane/target each pass — not a single repeating path."""
    motion = normalize_overlay_text_motion(motion)
    mx = int(margin_x)
    my = int(margin_y)
    if motion == "static":
        return str(mx), str(my)

    speed = clamp_logo_speed(speed_px_s)
    sp = f"{speed:.4f}"
    if motion == "rtl":
        lap = f"floor(t*{sp}/(W+w))"
        y = f"{_unit_hash(lap, 12.9898)}*max(H-h,1)"
        return _esc(f"W-mod(t*{sp},W+w)"), _esc(y)
    if motion == "diagonal":
        ysp = f"{speed * DIAGONAL_Y_SPEED_RATIO:.4f}"
        lap = f"floor(t*{sp}/(W+w))"
        yoff = f"{_unit_hash(f'{lap}+1', 78.233)}*(H+h)"
        return (
            _esc(f"W-mod(t*{sp},W+w)"),
            _esc(f"H-mod(t*{ysp}+{yoff},H+h)"),
        )
    if frame_w and frame_h and overlay_w and overlay_h:
        return _bounce_lerp_expr(speed, int(frame_w), int(frame_h), int(overlay_w), int(overlay_h))
    # Fallback if frame size unknown: still bounce in-frame (triangle).
    ysp = f"{speed * BOUNCE_Y_SPEED_RATIO:.4f}"
    rx, ry = "max(W-w,1)", "max(H-h,1)"
    sx = f"{BOUNCE_START_X_FRAC:g}*W"
    sy = f"{BOUNCE_START_Y_FRAC:g}*H"
    return (
        _esc(f"abs(mod(t*{sp}+{rx}+{sx},2*{rx})-{rx})"),
        _esc(f"abs(mod(t*{ysp}+{ry}+{sy},2*{ry})-{ry})"),
    )


def build_overlay_text_overlay_filter(
    main_pad: str,
    overlay_pad: str,
    out_pad: str,
    motion: str,
    speed_px_s: float,
    margin_x: int,
    margin_y: int,
    frame_w: int | None = None,
    frame_h: int | None = None,
    overlay_w: int | None = None,
    overlay_h: int | None = None,
) -> str:
    x_expr, y_expr = overlay_text_overlay_xy_expr(
        motion,
        speed_px_s,
        margin_x,
        margin_y,
        frame_w=frame_w,
        frame_h=frame_h,
        overlay_w=overlay_w,
        overlay_h=overlay_h,
    )
    return f"{main_pad}{overlay_pad}overlay=x='{x_expr}':y='{y_expr}'{out_pad}"


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
    # bounce: triangle wave full frame; bắt đầu ~25% ngang, 0% dọc.
    ysp = f"{speed * BOUNCE_Y_SPEED_RATIO:.4f}"
    rx = "max(W-w,1)"
    ry = "max(H-h,1)"
    sx = f"{BOUNCE_START_X_FRAC:g}*W"
    sy = f"{BOUNCE_START_Y_FRAC:g}*H"
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
