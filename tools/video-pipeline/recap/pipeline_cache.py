"""Artifact cache helpers — skip pipeline steps when outputs already exist in work dir."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def artifact_fresh(artifact: Path, *sources: Path) -> bool:
    """True when artifact exists and is not older than any existing source file."""
    if not artifact.is_file():
        return False
    art_mtime = artifact.stat().st_mtime
    for src in sources:
        if src.is_file() and src.stat().st_mtime > art_mtime:
            return False
    return True


def knowledge_has_candidates(knowledge: dict[str, Any]) -> bool:
    events = knowledge.get("events") or []
    if not events:
        return False
    return any(len(ev.get("candidate_shots") or []) > 0 for ev in events)


def tts_signature(
    engine: str,
    *,
    voice: str = "",
    rate: str = "",
    ref_audio: str | None = None,
    ref_text: str | None = None,
    language: str | None = None,
) -> str:
    return "|".join(
        [
            str(engine or "").strip().lower(),
            str(voice or "").strip(),
            str(rate or "").strip(),
            str(ref_audio or "").strip(),
            str(ref_text or "").strip(),
            str(language or "").strip(),
        ]
    )


def normalize_tts_meta(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        if "durationSec" not in item and "audioDur" in item:
            item["durationSec"] = item["audioDur"]
        out.append(item)
    return out


def try_load_tts_cache(
    tts_path: Path,
    narrations: list[str],
    signature: str,
    *,
    script_path: Path | None = None,
) -> list[dict[str, Any]] | None:
    if not tts_path.is_file():
        return None
    if script_path is not None and script_path.is_file():
        if script_path.stat().st_mtime > tts_path.stat().st_mtime:
            return None
    try:
        raw = load_json(tts_path)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(raw, list) or len(raw) != len(narrations):
        return None
    for i, (row, text) in enumerate(zip(raw, narrations)):
        if not isinstance(row, dict):
            return None
        if row.get("text") != text:
            return None
        row_sig = str(row.get("signature") or "")
        if row_sig and row_sig != signature:
            return None
        if not row_sig:
            eng = str(row.get("engine") or "").strip().lower()
            if eng and eng != signature.split("|", 1)[0]:
                return None
        wav = Path(str(row.get("file") or ""))
        if not wav.is_file() or wav.stat().st_size <= 0:
            return None
        if int(row.get("i", i)) != i:
            return None
    return normalize_tts_meta(raw)


def try_load_timeline_cache(
    timeline_path: Path,
    cfg: dict[str, Any],
    *sources: Path,
) -> dict[str, Any] | None:
    if not artifact_fresh(timeline_path, *sources):
        return None
    try:
        timeline = load_json(timeline_path)
    except (json.JSONDecodeError, OSError):
        return None
    if not isinstance(timeline, dict):
        return None
    cfg_speed = float(cfg.get("videoSpeed") or 1.0)
    tl_speed = float(timeline.get("videoSpeed") or 1.0)
    if abs(cfg_speed - tl_speed) > 0.01:
        return None
    return timeline
