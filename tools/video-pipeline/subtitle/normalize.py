"""Text normalization and similarity utilities for subtitle OCR."""

from __future__ import annotations

import re
from collections import Counter

_RE_KEEP = re.compile(r"[\w\s\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+")


def clean_text(text: str) -> str:
    """Remove noise characters, collapse whitespace."""
    return re.sub(r"\s+", " ", " ".join(_RE_KEEP.findall(text))).strip()


def same_subtitle_line(prev: str, curr: str, fuzzy_threshold: float) -> bool:
    """Determine if two subtitle texts are the same line (fuzzy match).

    Uses RapidFuzz when available, falls back to difflib.SequenceMatcher.
    """
    try:
        from rapidfuzz import fuzz
        if fuzz.ratio(prev, curr) >= fuzzy_threshold:
            return True
    except ImportError:
        from difflib import SequenceMatcher
        if SequenceMatcher(None, prev, curr).ratio() * 100 >= fuzzy_threshold:
            return True

    a, b = prev.strip(), curr.strip()
    if len(a) < 2 or len(b) < 2:
        return False
    if a.startswith(b) or b.startswith(a):
        return True
    shorter, longer = (a, b) if len(a) <= len(b) else (b, a)
    if len(shorter) >= 4 and shorter in longer:
        return True
    maxlen = max(len(a), len(b), 1)
    if maxlen >= 8 and abs(len(a) - len(b)) <= 2:
        if sum((Counter(a) & Counter(b)).values()) / float(maxlen) >= 0.88:
            return True
    return False
