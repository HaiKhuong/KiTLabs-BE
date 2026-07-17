"""Timeline model — a list of Scenes describing subtitle / dragon pose / highlight / zoom."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

_VALID_SIDE = {"none", "left", "right"}


def _as_float(value: Any, fallback: float) -> float:
    try:
        if value is None or value == "":
            return fallback
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _as_side(value: Any) -> str:
    text = str(value or "none").strip().lower()
    return text if text in _VALID_SIDE else "none"


@dataclass
class Scene:
    start: float
    end: float
    dragon_pose: str
    subtitle: str
    highlight: str  # none | left | right
    zoom: str  # none | left | right

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @classmethod
    def from_dict(cls, data: dict[str, Any], prev_end: float) -> "Scene":
        start = _as_float(data.get("start"), prev_end)
        end = _as_float(data.get("end"), start)
        if end < start:
            end = start
        return cls(
            start=start,
            end=end,
            dragon_pose=str(data.get("dragonPose") or data.get("dragon_pose") or "idle").strip()
            or "idle",
            subtitle=str(data.get("subtitle") or "").strip(),
            highlight=_as_side(data.get("highlight")),
            zoom=_as_side(data.get("zoom")),
        )


@dataclass
class Timeline:
    scenes: list[Scene]

    @property
    def total_duration(self) -> float:
        if not self.scenes:
            return 0.0
        return max(scene.end for scene in self.scenes)

    def poses(self) -> list[str]:
        """Unique dragon poses that appear, preserving first-seen order."""
        seen: list[str] = []
        for scene in self.scenes:
            if scene.dragon_pose not in seen:
                seen.append(scene.dragon_pose)
        return seen

    def intervals_for_pose(self, pose: str) -> list[tuple[float, float]]:
        return [(s.start, s.end) for s in self.scenes if s.dragon_pose == pose]

    @classmethod
    def from_spec(cls, spec: dict[str, Any]) -> "Timeline":
        raw = spec.get("scenes")
        scenes: list[Scene] = []
        prev_end = 0.0
        if isinstance(raw, list):
            for item in raw:
                if not isinstance(item, dict):
                    continue
                scene = Scene.from_dict(item, prev_end)
                scenes.append(scene)
                prev_end = scene.end
        return cls(scenes=scenes)
