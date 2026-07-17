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
    highlight: str  # none | left | right (legacy)
    zoom: str  # none | left | right (legacy)
    focus: str  # none | left | right
    transition_sound: str  # named sfx key (e.g. "whoosh_fast") or "" / "none"

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    @classmethod
    def from_dict(cls, data: dict[str, Any], prev_end: float) -> "Scene":
        # Support both explicit start/end and duration-based sequential timing.
        if data.get("start") is None and data.get("end") is None and data.get("duration") is not None:
            start = prev_end
            end = start + max(0.0, _as_float(data.get("duration"), 0.0))
        else:
            start = _as_float(data.get("start"), prev_end)
            end = _as_float(data.get("end"), start)
            if end < start:
                end = start
        highlight = _as_side(data.get("highlight"))
        zoom = _as_side(data.get("zoom"))
        # `focus` is the new field; fall back to legacy highlight/zoom when absent.
        focus = _as_side(data.get("focus"))
        if focus == "none":
            focus = highlight if highlight != "none" else zoom
        return cls(
            start=start,
            end=end,
            dragon_pose=str(data.get("dragonPose") or data.get("dragon_pose") or "idle").strip()
            or "idle",
            subtitle=str(data.get("subtitle") or "").strip(),
            highlight=highlight,
            zoom=zoom,
            focus=focus,
            transition_sound=str(
                data.get("transitionSound") or data.get("transition_sound") or ""
            ).strip(),
        )


@dataclass
class Caption:
    start: float
    end: float
    text: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


# Hold the last caption on screen for this long when nothing else bounds it.
_LAST_CAPTION_HOLD = 2.0


@dataclass
class Timeline:
    scenes: list[Scene]
    captions: list["Caption"]

    @property
    def total_duration(self) -> float:
        ends = [scene.end for scene in self.scenes]
        ends += [caption.end for caption in self.captions]
        return max(ends) if ends else 0.0

    def poses(self) -> list[str]:
        """Unique dragon poses that appear, preserving first-seen order."""
        seen: list[str] = []
        for scene in self.scenes:
            if scene.dragon_pose not in seen:
                seen.append(scene.dragon_pose)
        return seen

    def intervals_for_pose(self, pose: str) -> list[tuple[float, float]]:
        return [(s.start, s.end) for s in self.scenes if s.dragon_pose == pose]

    def intervals_for_focus(self, side: str) -> list[tuple[float, float]]:
        """Time intervals where `side` (left/right) is the focused column."""
        return [(s.start, s.end) for s in self.scenes if s.focus == side]

    def pose_transition_times(self) -> list[float]:
        """Start times where the dragon pose changes from the previous scene."""
        times: list[float] = []
        prev: str | None = None
        for scene in self.scenes:
            if prev is not None and scene.dragon_pose != prev:
                times.append(scene.start)
            prev = scene.dragon_pose
        return times

    def transition_sound_hits(self) -> list[tuple[float, str]]:
        """(start_time, sound_name) for scenes that declare a transitionSound."""
        hits: list[tuple[float, str]] = []
        for scene in self.scenes:
            name = scene.transition_sound
            if name and name.lower() != "none":
                hits.append((scene.start, name))
        return hits

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

        captions = cls._build_captions(spec, scenes)
        return cls(scenes=scenes, captions=captions)

    @staticmethod
    def _build_captions(spec: dict[str, Any], scenes: list[Scene]) -> list["Caption"]:
        """Build subtitle captions.

        Prefer a top-level `captions: [{time, text}]` list — each caption's end is
        the next caption's `time` (the last one holds until the timeline end).
        Fall back to per-scene `subtitle` text when `captions` is absent.
        """
        raw = spec.get("captions")
        if isinstance(raw, list) and raw:
            parsed: list[tuple[float, str]] = []
            for item in raw:
                if not isinstance(item, dict):
                    continue
                text = str(item.get("text") or "").strip()
                if not text:
                    continue
                start = _as_float(item.get("time"), 0.0)
                parsed.append((start, text))
            parsed.sort(key=lambda p: p[0])

            scene_end = max((s.end for s in scenes), default=0.0)
            captions: list[Caption] = []
            for i, (start, text) in enumerate(parsed):
                if i + 1 < len(parsed):
                    end = parsed[i + 1][0]
                else:
                    end = max(scene_end, start + _LAST_CAPTION_HOLD)
                if end < start:
                    end = start + _LAST_CAPTION_HOLD
                captions.append(Caption(start=start, end=end, text=text))
            return captions

        # Backward compatible: derive captions from scene subtitles.
        return [
            Caption(start=s.start, end=s.end, text=s.subtitle)
            for s in scenes
            if s.subtitle
        ]
