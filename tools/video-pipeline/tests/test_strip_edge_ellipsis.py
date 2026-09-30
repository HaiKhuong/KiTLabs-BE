"""Strip leading/trailing ellipsis; keep mid-sentence ellipsis."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from subtitle.cue_text import strip_edge_ellipsis  # noqa: E402


class TestStripEdgeEllipsis(unittest.TestCase):
    def test_trailing(self):
        self.assertEqual(
            strip_edge_ellipsis("Mục đích tôi đến đây..."),
            "Mục đích tôi đến đây",
        )

    def test_leading(self):
        self.assertEqual(
            strip_edge_ellipsis("...ông nên hiểu rõ."),
            "ông nên hiểu rõ.",
        )

    def test_keep_middle(self):
        self.assertEqual(
            strip_edge_ellipsis("Tiềm... Tiềm Uyên Các hạ!"),
            "Tiềm... Tiềm Uyên Các hạ!",
        )

    def test_unicode_ellipsis(self):
        self.assertEqual(strip_edge_ellipsis("…xin chào"), "xin chào")
        self.assertEqual(strip_edge_ellipsis("xin chào…"), "xin chào")

    def test_both_ends(self):
        self.assertEqual(strip_edge_ellipsis("...giữa..."), "giữa")


if __name__ == "__main__":
    unittest.main()
