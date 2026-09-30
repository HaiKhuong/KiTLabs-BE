"""Cue text cleanup for Vietnamese SRT (post-translate)."""

from __future__ import annotations

import re

# "..." / ". . ." / "……" — chỉ neo đầu/cuối câu, không đụng "Tiềm... Tiềm".
_EDGE_ELLIPSIS = r"(?:…+|(?:\.\s*){3,})"


def strip_edge_ellipsis(text: str) -> str:
    """Bỏ dấu ba chấm ở đầu và cuối câu; giữ nguyên nếu nằm giữa."""
    t = str(text or "")
    t = re.sub(rf"^\s*{_EDGE_ELLIPSIS}\s*", "", t)
    t = re.sub(rf"\s*{_EDGE_ELLIPSIS}\s*$", "", t)
    return t.strip()
