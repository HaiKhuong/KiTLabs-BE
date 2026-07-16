"""CallA-2 — Script Writer: story knowledge → narration segments + visualBeats."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from call_a1_story_analyst import EMOTIONS
from gemini_recap import (
    SCRIPT_DURATION_SEC,
    SCRIPT_MOVIE_WINDOWS,
    SCRIPT_NARRATIONS,
    SCRIPT_RECAP_TIMELINE,
    SCRIPT_TITLE,
    _generate_json,
)

LOG = logging.getLogger("recap.call_a2")

SYSTEM_A2 = """# ROLE

You are an award-winning YouTube movie recap writer and film editor.

Your job is to transform a structured movie outline into a complete, engaging movie recap script.

You are NOT selecting video shots.

You are designing HOW the audience should experience the story.

Every narration segment must also include a visual storytelling plan so another AI editor can later choose the correct movie shots.

---

# INPUT

You will receive:

- Movie title
- Movie summary
- Story outline
- Characters
- Important events
- Story timeline
- language — write all narration text in this language

Example

{
    "movieTitle": "...",
    "summary": "...",
    "storyOutline": [...],
    "characters": [...],
    "events": [...],
    "language": "vi"
}

---

# GOAL

Generate a professional movie recap script.

The recap should:

- sound like a popular YouTube movie recap channel
- be chronological
- preserve all important story events
- explain motivations
- explain cause and effect
- explain character decisions
- explain emotional changes
- keep viewers curious

The target total narration length is approximately 15 minutes.
If input includes targetNarrationRange [minSec, maxSec], stay within that range.

---

# NARRATION STYLE

Write naturally.

Use storytelling.

Avoid reading like subtitles.

Instead of

"John says..."

Write

"John realizes..."

Instead of

"He walks."

Write

"He quietly walks toward the abandoned castle, unaware that everything is about to change."

Explain WHY things happen.

Connect events naturally.

Avoid repeating names unnecessarily.

---

# VISUAL PLAN

For every narration segment, generate visual beats.

A visual beat is a single important visual moment.

A visual beat should describe:

- what should appear on screen
- the key action
- the emotional focus

A visual beat should NOT describe:

- camera angles
- zoom
- editing
- transitions

Example

Narration

"John finally escapes from prison after defeating the guards."

Visual Beats

1.
John sneaks through the prison corridor.

2.
John fights the guards.

3.
John opens the prison gate.

4.
John runs outside into freedom.

These beats will later be matched with candidate shots.

---

# SEGMENT RULES

Each narration segment should

- describe one logical story event
- last around 20~40 seconds
- contain 2~6 visual beats

Do not create segments that are too small.

Do not merge unrelated events.

---

# EMOTION

Assign one emotion to every segment.

Allowed values

- calm
- mystery
- suspense
- action
- happy
- sad
- emotional
- horror
- tense
- climax

---

# IMPORTANCE

Assign importance

1~10

10 means

- climax
- plot twist
- major reveal
- emotional peak

---

# OUTPUT

Return JSON only.

{
  "segments":[

    {
      "segmentId":1,

      "title":"John's Childhood",

      "importance":3,

      "emotion":"calm",

      "estimatedDuration":28,

      "narration":

      "John grows up in a poor village with his mother. Although life is difficult, he dreams of leaving the village one day.",

      "visualBeats":[

        {
          "order":1,
          "description":"Young John living in a poor village."
        },

        {
          "order":2,
          "description":"John spending time with his mother."
        },

        {
          "order":3,
          "description":"John looking toward the distant city."
        }

      ]
    }

  ]
}

---

# IMPORTANT

Visual beats must describe STORY EVENTS.

Do NOT describe camera movement.

Do NOT describe cinematic language.

Do NOT describe editing techniques.

Only describe what should appear on screen.

---

# NARRATION QUALITY

Every narration should:

- explain the story clearly
- preserve emotional progression
- maintain curiosity
- naturally connect to the next segment
- avoid unnecessary dialogue
- avoid filler

---

# OUTPUT REQUIREMENTS

Return valid JSON only.

Do not output Markdown.

Do not explain anything.

Do not include any text outside the JSON."""


def _normalize_emotion(v: Any) -> str:
    s = str(v or "calm").strip().lower()
    if s in EMOTIONS:
        return s
    return "calm"


def _clamp_importance(v: Any) -> int:
    try:
        n = int(round(float(v)))
    except Exception:
        n = 5
    return max(1, min(10, n))


def _clamp_duration(v: Any, *, min_sec: float = 20.0, max_sec: float = 40.0) -> float:
    try:
        d = float(v)
    except Exception:
        d = 28.0
    return max(min_sec, min(max_sec, d))


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[a-zA-ZÀ-ỹ0-9]{3,}", (text or "").lower()))


def canonicalize_segments(raw: dict[str, Any]) -> list[dict[str, Any]]:
    segs_in = raw.get("segments") if isinstance(raw.get("segments"), list) else []
    out: list[dict[str, Any]] = []
    for i, seg in enumerate(segs_in):
        if not isinstance(seg, dict):
            continue
        narration = str(seg.get("narration") or seg.get("text") or "").strip()
        if not narration:
            continue
        beats_in = seg.get("visualBeats") or seg.get("visual_beats") or []
        beats: list[dict[str, Any]] = []
        if isinstance(beats_in, list):
            for j, b in enumerate(beats_in):
                if isinstance(b, dict):
                    desc = str(b.get("description") or b.get("text") or "").strip()
                else:
                    desc = str(b).strip()
                if not desc:
                    continue
                beats.append({"order": len(beats) + 1, "description": desc})
        if len(beats) < 2:
            # synthesize minimal beats from narration clauses
            parts = [p.strip() for p in re.split(r"[.!?]+", narration) if p.strip()]
            while len(beats) < 2 and parts:
                beats.append({"order": len(beats) + 1, "description": parts[len(beats)][:160]})
            while len(beats) < 2:
                beats.append(
                    {
                        "order": len(beats) + 1,
                        "description": narration[:120] or f"Visual moment {len(beats) + 1}",
                    }
                )
        beats = beats[:6]
        for j, b in enumerate(beats):
            b["order"] = j + 1
        out.append(
            {
                "segmentId": int(seg.get("segmentId") or i + 1),
                "title": str(seg.get("title") or f"Segment {i + 1}").strip(),
                "importance": _clamp_importance(seg.get("importance")),
                "emotion": _normalize_emotion(seg.get("emotion")),
                "estimatedDuration": _clamp_duration(seg.get("estimatedDuration")),
                "narration": narration,
                "visualBeats": beats,
                "eventIds": [],
            }
        )
    for i, seg in enumerate(out):
        seg["segmentId"] = i + 1
    return out


def build_a2_payload(knowledge: dict[str, Any], *, locale: str, dur_min: int, dur_max: int) -> dict[str, Any]:
    acts = knowledge.get("storyActs") or []
    outline = [str(a.get("summary") or a.get("title") or "") for a in acts if isinstance(a, dict)]
    outline = [x for x in outline if x]
    characters = []
    for c in knowledge.get("characters") or []:
        if not isinstance(c, dict):
            continue
        characters.append(
            {
                "id": c.get("id"),
                "name": c.get("name"),
                "role": c.get("role"),
                "description": c.get("description"),
            }
        )
    events = []
    for e in knowledge.get("events") or []:
        if not isinstance(e, dict):
            continue
        events.append(
            {
                "eventId": e.get("eventId"),
                "title": e.get("title"),
                "summary": e.get("summary"),
                "importance": e.get("importance"),
                "emotion": e.get("emotion"),
                "window": e.get("window"),
            }
        )
    return {
        "movieTitle": knowledge.get("movieTitle") or "",
        "summary": knowledge.get("movieSummary") or "",
        "storyOutline": outline,
        "characters": characters,
        "events": events,
        "language": locale,
        "targetNarrationRange": [dur_min, dur_max],
    }


def map_event_ids_to_segments(
    segments: list[dict[str, Any]],
    knowledge: dict[str, Any],
) -> list[dict[str, Any]]:
    """Greedy chronological match of events → segments (text + order)."""
    events = [e for e in (knowledge.get("events") or []) if isinstance(e, dict)]
    if not events or not segments:
        return segments

    n_seg = len(segments)
    n_ev = len(events)
    # Base partition: chronological buckets so windows stay local
    for si, seg in enumerate(segments):
        start = int(round(si * n_ev / n_seg))
        end = int(round((si + 1) * n_ev / n_seg))
        if end <= start:
            end = min(n_ev, start + 1)
        bucket = list(range(start, min(n_ev, end)))
        if not bucket and n_ev:
            bucket = [min(n_ev - 1, start)]

        q = _tokens(f"{seg.get('title', '')} {seg.get('narration', '')}")
        for vb in seg.get("visualBeats") or []:
            q |= _tokens(str(vb.get("description") or ""))

        # Optionally pull adjacent event with strong text overlap
        neighbors = set(bucket)
        for ei in range(max(0, start - 1), min(n_ev, end + 1)):
            ev = events[ei]
            et = _tokens(f"{ev.get('title', '')} {ev.get('summary', '')}")
            overlap = len(q & et) / max(1, len(et) or 1)
            if overlap >= 0.35:
                neighbors.add(ei)
        chosen = sorted(neighbors)
        # Cap to avoid one segment swallowing the whole movie
        max_take = max(1, (n_ev + n_seg - 1) // n_seg + 1)
        if len(chosen) > max_take:
            # keep those inside primary bucket first
            primary = [ei for ei in chosen if ei in bucket][:max_take]
            if len(primary) < max_take:
                for ei in chosen:
                    if ei not in primary:
                        primary.append(ei)
                    if len(primary) >= max_take:
                        break
            chosen = primary
        seg["eventIds"] = [str(events[ei]["eventId"]) for ei in chosen]

    # Ensure every event assigned at least once
    assigned = {eid for s in segments for eid in (s.get("eventIds") or [])}
    for ei, ev in enumerate(events):
        eid = str(ev["eventId"])
        if eid in assigned:
            continue
        idx = min(n_seg - 1, max(0, int(ei * n_seg / max(1, n_ev))))
        segments[idx].setdefault("eventIds", []).append(eid)
        assigned.add(eid)

    return segments


def derive_script_from_segments(
    segments: list[dict[str, Any]],
    knowledge: dict[str, Any],
    *,
    movie_dur: float,
) -> dict[str, Any]:
    events_by_id = {
        str(e["eventId"]): e
        for e in (knowledge.get("events") or [])
        if isinstance(e, dict) and e.get("eventId")
    }
    narrations: list[str] = []
    recap_timeline: list[list[float]] = []
    movie_windows: list[list[float]] = []
    t = 0.0
    for seg in segments:
        narration = str(seg.get("narration") or "").strip()
        if not narration:
            continue
        dur = float(seg.get("estimatedDuration") or 28.0)
        narrations.append(narration)
        recap_timeline.append([round(t, 1), round(t + dur, 1)])
        t += dur

        eids = [str(x) for x in (seg.get("eventIds") or [])]
        if eids:
            fs = [float(events_by_id[e]["window"]["from"]) for e in eids if e in events_by_id]
            ts = [float(events_by_id[e]["window"]["to"]) for e in eids if e in events_by_id]
            if fs and ts:
                movie_windows.append([round(min(fs), 1), round(max(ts), 1)])
            else:
                movie_windows.append([0.0, min(movie_dur, 60.0)])
        else:
            # proportional fallback
            ratio0 = (len(narrations) - 1) / max(1, len(segments))
            ratio1 = len(narrations) / max(1, len(segments))
            movie_windows.append([round(movie_dur * ratio0, 1), round(movie_dur * ratio1, 1)])

    title = str(knowledge.get("movieTitle") or "Recap")
    return {
        SCRIPT_TITLE: f"Recap: {title}",
        SCRIPT_DURATION_SEC: round(t, 1) if recap_timeline else 0.0,
        SCRIPT_NARRATIONS: narrations,
        SCRIPT_RECAP_TIMELINE: recap_timeline,
        SCRIPT_MOVIE_WINDOWS: movie_windows,
    }


def heuristic_segments(knowledge: dict[str, Any], *, locale: str = "vi") -> list[dict[str, Any]]:
    events = [e for e in (knowledge.get("events") or []) if isinstance(e, dict)]
    # Prefer important events; keep chronological
    picked = [e for e in events if int(e.get("importance") or 5) >= 5]
    if len(picked) < 8:
        picked = events
    if not picked:
        picked = [
            {
                "eventId": "EV_001",
                "title": "Story",
                "summary": knowledge.get("movieSummary") or knowledge.get("movieTitle") or "Story",
                "importance": 5,
                "emotion": "calm",
                "window": {"from": 0, "to": 60},
            }
        ]

    segments: list[dict[str, Any]] = []
    for i, ev in enumerate(picked):
        summary = str(ev.get("summary") or ev.get("title") or "").strip()
        title = str(ev.get("title") or f"Segment {i + 1}")
        if locale.startswith("vi"):
            narration = summary if summary else f"Câu chuyện tiếp tục với {title}."
        else:
            narration = summary if summary else f"The story continues with {title}."
        words = summary.split()
        beats = []
        chunk = max(1, len(words) // 3) if words else 1
        for j in range(min(3, max(2, len(words) // max(chunk, 1)))):
            start = j * chunk
            piece = " ".join(words[start : start + chunk]) or title
            beats.append({"order": j + 1, "description": piece[:160]})
        while len(beats) < 2:
            beats.append({"order": len(beats) + 1, "description": title})
        segments.append(
            {
                "segmentId": i + 1,
                "title": title,
                "importance": _clamp_importance(ev.get("importance")),
                "emotion": _normalize_emotion(ev.get("emotion")),
                "estimatedDuration": 28.0,
                "narration": narration,
                "visualBeats": beats[:6],
                "eventIds": [str(ev.get("eventId"))] if ev.get("eventId") else [],
            }
        )
    return segments


def generate_narration_segments(
    knowledge: dict[str, Any],
    *,
    locale: str = "vi",
    dur_min: int = 900,
    dur_max: int = 1200,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
) -> list[dict[str, Any]]:
    payload = build_a2_payload(knowledge, locale=locale, dur_min=dur_min, dur_max=dur_max)
    result = _generate_json(
        SYSTEM_A2,
        payload,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag="gemini_a2",
    )
    segments = canonicalize_segments(result)
    if segments:
        return map_event_ids_to_segments(segments, knowledge)
    LOG.warning("CallA-2 invalid or empty; using heuristic segments")
    return map_event_ids_to_segments(heuristic_segments(knowledge, locale=locale), knowledge)


def merged_candidates_for_segment(
    segment: dict[str, Any],
    knowledge: dict[str, Any],
    limit: int = 32,
) -> list[dict[str, Any]]:
    events_by_id = {
        str(e["eventId"]): e
        for e in (knowledge.get("events") or [])
        if isinstance(e, dict) and e.get("eventId")
    }
    by_id: dict[int, dict[str, Any]] = {}
    for eid in segment.get("eventIds") or []:
        ev = events_by_id.get(str(eid))
        if not ev:
            continue
        for c in ev.get("candidate_shots") or []:
            sid = int(c.get("shot_id") or c.get("id") or -1)
            if sid < 0:
                continue
            prev = by_id.get(sid)
            if not prev or float(c.get("score") or 0) > float(prev.get("score") or 0):
                by_id[sid] = {
                    "id": sid,
                    "shot_id": sid,
                    "score": float(c.get("score") or 0),
                    "startSec": c.get("startSec"),
                    "endSec": c.get("endSec"),
                    "durationSec": c.get("durationSec"),
                    "subtitle": c.get("subtitle") or "",
                }
    ranked = sorted(by_id.values(), key=lambda x: float(x["score"]), reverse=True)
    return ranked[:limit]
