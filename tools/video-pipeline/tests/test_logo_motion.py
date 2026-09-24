"""Unit tests for FFmpeg logo overlay motion expressions."""

from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.logo_motion import (  # noqa: E402
    build_logo_overlay_filter,
    build_overlay_text_overlay_filter,
    logo_overlay_xy_expr,
    normalize_logo_motion,
    overlay_text_overlay_xy_expr,
)


class TestNormalizeLogoMotion(unittest.TestCase):
    def test_known_modes(self):
        self.assertEqual(normalize_logo_motion("rtl"), "rtl")
        self.assertEqual(normalize_logo_motion("BOUNCE"), "bounce")

    def test_unknown_falls_back_to_static(self):
        self.assertEqual(normalize_logo_motion("spin"), "static")
        self.assertEqual(normalize_logo_motion(None), "static")


class TestLogoOverlayExpr(unittest.TestCase):
    def test_static_uses_margins(self):
        x, y = logo_overlay_xy_expr("static", 140, 30, 40)
        self.assertEqual(x, "30")
        self.assertEqual(y, "40")

    def test_rtl_wraps_from_right_and_keeps_y(self):
        x, y = logo_overlay_xy_expr("rtl", 120, 0, 48)
        self.assertIn("W-mod(t*", x)
        self.assertIn("W+w", x)
        self.assertEqual(y, "48")
        self.assertIn("\\,", x)

    def test_diagonal_moves_both_axes(self):
        x, y = logo_overlay_xy_expr("diagonal", 100, 0, 0)
        self.assertIn("W-mod(t*", x)
        self.assertIn("H-mod(t*", y)
        self.assertIn("\\,", x)
        self.assertIn("\\,", y)

    def test_bounce_uses_triangle_wave_with_start_offset(self):
        x, y = logo_overlay_xy_expr("bounce", 150, 0, 0)
        self.assertIn("0.25*W", x)
        self.assertIn("0*H", y)
        self.assertIn("max(W-w\\,1)", x)
        self.assertIn("max(H-h\\,1)", y)

    def test_overlay_filter_string(self):
        clause = build_logo_overlay_filter(
            "[vsub]",
            "[logo]",
            "[vout]",
            "rtl",
            120,
            10,
            20,
        )
        self.assertTrue(clause.startswith("[vsub][logo]overlay=x='"))
        self.assertIn("':y='20'[vout]", clause)


class TestOverlayTextMotion(unittest.TestCase):
    def test_rtl_randomizes_y_per_lap(self):
        x, y = overlay_text_overlay_xy_expr("rtl", 140, 0, 80)
        self.assertIn("W-mod(t*", x)
        self.assertIn("floor(t*", y)
        self.assertIn("sin(", y)
        self.assertNotEqual(y, "80")

    def test_diagonal_phase_shifts_per_lap(self):
        _x, y = overlay_text_overlay_xy_expr("diagonal", 100, 0, 0)
        self.assertIn("floor(t*", y)
        self.assertIn("sin(", y)
        self.assertIn("H-mod(t*", y)

    def test_bounce_random_angle_stays_in_frame(self):
        from subtitle.logo_motion import overlay_bounce_pos, _overlay_bounce_outgoing

        rx, ry = 1520.0, 980.0
        for t in (0.0, 0.5, 1.2, 3.0, 8.0, 21.0):
            x, y = overlay_bounce_pos(t, 150, rx, ry, 1920, 1080)
            self.assertGreaterEqual(x, -1e-6)
            self.assertGreaterEqual(y, -1e-6)
            self.assertLessEqual(x, rx + 1e-6)
            self.assertLessEqual(y, ry + 1e-6)
        for seg in range(12):
            for side in range(4):
                vx, vy = _overlay_bounce_outgoing(side, seg, 100.0)
                if side in (0, 2):
                    wall_angle = math.degrees(math.atan2(abs(vy), abs(vx)))
                else:
                    wall_angle = math.degrees(math.atan2(abs(vx), abs(vy)))
                self.assertGreater(wall_angle, 45.0)

    def test_bounce_uses_piecewise_path_when_sized(self):
        x, y = overlay_text_overlay_xy_expr(
            "bounce", 150, 0, 0, frame_w=1920, frame_h=1080, overlay_w=400, overlay_h=80
        )
        self.assertIn("between(", x)
        self.assertIn("between(", y)
        self.assertIn("mod(t", x)

    def test_bounce_triangle_fallback_without_size(self):
        x, y = overlay_text_overlay_xy_expr("bounce", 150, 0, 0)
        self.assertIn("abs(mod(t*", x)
        self.assertIn("abs(mod(t*", y)

    def test_overlay_text_filter_string(self):
        clause = build_overlay_text_overlay_filter(
            "[vsub]",
            "[otxt]",
            "[votxt]",
            "rtl",
            140,
            0,
            80,
        )
        self.assertTrue(clause.startswith("[vsub][otxt]overlay=x='"))
        self.assertIn("[votxt]", clause)


if __name__ == "__main__":
    unittest.main()
