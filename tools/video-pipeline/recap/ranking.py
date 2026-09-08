"""Configurable multi-score shot ranking + CallA-2 duration quota helpers."""

from __future__ import annotations

import math
import os
from typing import Any


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def ranking_config(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    raw = (cfg or {}).get("ranking") if isinstance((cfg or {}).get("ranking"), dict) else {}
    weights = raw.get("weights") if isinstance(raw.get("weights"), dict) else raw
    return {
        "clip": float(weights.get("clip", _env_float("RECAP_RANK_CLIP", 0.45))),
        "temporal": float(weights.get("temporal", _env_float("RECAP_RANK_TEMPORAL", 0.20))),
        "quality": float(weights.get("quality", _env_float("RECAP_RANK_QUALITY", 0.15))),
        "scene": float(weights.get("scene", _env_float("RECAP_RANK_SCENE", 0.10))),
        "character": float(weights.get("character", _env_float("RECAP_RANK_CHARACTER", 0.0))),
        "repeat": float(weights.get("repeat", _env_float("RECAP_RANK_REPEAT", 0.10))),
        "temporalDecaySec": float(raw.get("temporalDecaySec", _env_float("RECAP_RANK_TEMPORAL_DECAY", 25.0))),
        "lambdaRel": float(raw.get("lambdaRel", _env_float("RECAP_RANK_LAMBDA", 0.7))),
        "sceneCap": int(raw.get("sceneCap", _env_float("RECAP_RANK_SCENE_CAP", 2))),
        "consecutivePenalty": float(
            raw.get("consecutivePenalty", _env_float("RECAP_RANK_CONSECUTIVE", 0.82))
        ),
        "nearShotRadius": int(raw.get("nearShotRadius", _env_float("RECAP_RANK_NEAR_SHOT", 1))),
        "sceneCooldownSegments": int(
            raw.get("sceneCooldownSegments", _env_float("RECAP_RANK_SCENE_COOLDOWN", 2))
        ),
        "reuseMinIdGap": int(raw.get("reuseMinIdGap", _env_float("RECAP_RANK_REUSE_GAP", 8))),
        "reuseCooldownSegments": int(
            raw.get("reuseCooldownSegments", _env_float("RECAP_RANK_REUSE_COOLDOWN", 2))
        ),
        "storyCursorSlack": int(raw.get("storyCursorSlack", _env_float("RECAP_RANK_STORY_SLACK", 0))),
        "openingSegments": int(raw.get("openingSegments", _env_float("RECAP_RANK_OPENING_SEGMENTS", 3))),
        "openingShotFrac": float(raw.get("openingShotFrac", _env_float("RECAP_RANK_OPENING_FRAC", 0.12))),
        "openingMaxGap": int(raw.get("openingMaxGap", _env_float("RECAP_RANK_OPENING_MAX_GAP", 6))),
        "openingMinQuality": float(raw.get("openingMinQuality", _env_float("RECAP_RANK_OPENING_MIN_Q", 0.28))),
        "endingSegments": int(raw.get("endingSegments", _env_float("RECAP_RANK_ENDING_SEGMENTS", 3))),
        "endingShotFrac": float(raw.get("endingShotFrac", _env_float("RECAP_RANK_ENDING_FRAC", 0.12))),
        "minShotSecForSecondary": float(
            raw.get("minShotSecForSecondary", _env_float("RECAP_RANK_MIN_SHOT_SEC", 3.5))
        ),
        "motionThreshold": float(raw.get("motionThreshold", _env_float("RECAP_RANK_MOTION", 0.22))),
        "maxSecondaryPerShot": int(raw.get("maxSecondaryPerShot", _env_float("RECAP_RANK_MAX_SECONDARY", 1))),
    }


def clip01(v: float) -> float:
    return max(0.0, min(1.0, float(v)))


def temporal_score(shot_mid: float, event_mid: float, *, decay_sec: float = 25.0) -> float:
    dist = abs(float(shot_mid) - float(event_mid))
    decay = max(1.0, float(decay_sec))
    return math.exp(-dist / decay)


def quality_score(quality: dict[str, Any] | None) -> float:
    if not quality:
        return 0.55
    blur = float(quality.get("blur") or 0)
    bright = float(quality.get("brightness") or 0.5)
    contrast = float(quality.get("contrast") or 0.4)
    trans = float(quality.get("transitionRisk") or 0)
    visual = float(quality.get("visualChange") or quality.get("motion") or 0)
    brightness_ok = max(0.0, 1.0 - abs(bright - 0.52) * 1.6)
    return max(
        0.0,
        min(
            1.0,
            0.42 * (1.0 - blur)
            + 0.22 * brightness_ok
            + 0.18 * contrast
            + 0.10 * (1.0 - trans)
            + 0.08 * clip01(visual),
        ),
    )


def final_score(
    *,
    clip_sim: float,
    temporal: float,
    quality: float,
    scene: float,
    character: float = 0.0,
    repeat_hint: float = 0.0,
    cfg: dict[str, Any] | None = None,
) -> float:
    w = ranking_config(cfg)
    raw = (
        w["clip"] * clip01(clip_sim)
        + w["temporal"] * clip01(temporal)
        + w["quality"] * clip01(quality)
        + w["scene"] * clip01(scene)
        + w["character"] * clip01(character)
        - w["repeat"] * clip01(repeat_hint)
    )
    return round(raw, 4)


def shot_mid(shot: dict[str, Any]) -> float:
    return (float(shot.get("startSec") or 0) + float(shot.get("endSec") or 0)) / 2.0


def a2_length_quota(
    dur_min: int,
    dur_max: int,
    *,
    wpm: int = 140,
    seg_dur: float = 28.0,
) -> dict[str, Any]:
    dmin = max(60, int(dur_min))
    dmax = max(dmin, int(dur_max))
    mid = int(round((dmin + dmax) / 2))
    wpm = max(80, int(wpm))
    seg = max(22.0, min(38.0, float(seg_dur)))
    n = int(round(mid / seg))
    n = max(12, min(64, n))
    words_total = int(round(mid * wpm / 60.0))
    words_lo = int(round(22.0 * wpm / 60.0))
    words_hi = int(round(38.0 * wpm / 60.0))
    return {
        "targetNarrationRange": [dmin, dmax],
        "targetMidSec": mid,
        "wordsPerMinute": wpm,
        "targetTotalWords": words_total,
        "targetSegmentCount": n,
        "segmentDurationSec": [22, 38],
        "wordsPerSegmentRange": [words_lo, words_hi],
    }


def estimate_narration_sec(segments: list[dict[str, Any]], *, wpm: int = 140) -> float:
    import re

    words = 0
    for seg in segments:
        text = str(seg.get("narration") or "")
        words += len(re.findall(r"\S+", text))
    return words / max(80, wpm) * 60.0


def duration_out_of_range(est_sec: float, dur_min: int, dur_max: int) -> bool:
    return est_sec < dur_min * 0.85 or est_sec > dur_max * 1.15
