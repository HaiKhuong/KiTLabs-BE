"""Unit tests for FFmpeg logo overlay motion expressions."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.logo_motion import (  # noqa: E402
    build_logo_overlay_filter,
    logo_overlay_xy_expr,
    normalize_logo_motion,
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

    def test_bounce_uses_triangle_wave(self):
        x, y = logo_overlay_xy_expr("bounce", 150, 0, 0)
        self.assertTrue(x.startswith("abs(mod(t*"))
        self.assertTrue(y.startswith("abs(mod(t*"))
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


if __name__ == "__main__":
    unittest.main()
