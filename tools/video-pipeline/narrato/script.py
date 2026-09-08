"""Normalize Narrato-style cut script items."""

from __future__ import annotations

import os
import re
from typing import Any

from asr import parse_timestamp_range

PUBLIC_FIELDS = ("_id", "video_id", "video_name", "timestamp", "picture", "narration", "OST")
ORIG_RE = re.compile(r"^ORIG(\d+)$", re.I)


def orig_marker(item_id: int) -> str:
    return f"ORIG{int(item_id)}"


def is_orig_narration(text: str, item_id: int | None = None) -> bool:
    raw = str(text or "").strip()
    match = ORIG_RE.match(raw)
    if not match:
        return False
    if item_id is None:
        return True
    return int(match.group(1)) == int(item_id)


def parse_and_fix_json(json_string: str) -> Any:
    from gemini_client import parse_json_object

    if isinstance(json_string, (dict, list)):
        return json_string
    return parse_json_object(str(json_string or ""))


def _coerce_int(value: Any, default: int = 1) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_items(items: Any, video_name: str = "") -> list[dict[str, Any]]:
    if isinstance(items, dict):
        items = items.get("items")
    if not isinstance(items, list) or not items:
        raise ValueError("script items must be a non-empty list")

    out: list[dict[str, Any]] = []
    for index, raw in enumerate(items, start=1):
        if not isinstance(raw, dict):
            raise ValueError(f"item {index} must be an object")
        item_id = _coerce_int(raw.get("_id"), index)
        ost = _coerce_int(raw.get("OST"), 0)
        if ost not in (0, 1, 2):
            ost = 0
        timestamp = str(raw.get("timestamp") or "").strip()
        parse_timestamp_range(timestamp)
        narration = str(raw.get("narration") or "").strip()
        if ost == 1:
            narration = orig_marker(item_id)
        elif not narration:
            raise ValueError(f"item {item_id} narration is empty")
        name = str(raw.get("video_name") or video_name or "").strip() or os.path.basename(video_name)
        out.append(
            {
                "_id": item_id,
                "video_id": _coerce_int(raw.get("video_id"), 1),
                "video_name": name,
                "timestamp": timestamp,
                "picture": str(raw.get("picture") or "").strip(),
                "narration": narration,
                "OST": ost,
            }
        )
    return out


def script_payload(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"items": items}
