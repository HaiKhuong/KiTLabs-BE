"""CallA-1 — Story Analyst: transcript → structured story knowledge."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from cluster import shortlist_shots
from gemini_recap import _generate_json

LOG = logging.getLogger("recap.call_a1")

EMOTIONS = frozenset(
    {
        "calm",
        "happy",
        "mystery",
        "sad",
        "suspense",
        "action",
        "tense",
        "horror",
        "emotional",
        "climax",
    }
)

SYSTEM_A1 = """# ROLE

You are an expert movie analyst.

Your responsibility is to understand the complete movie and convert it into structured story knowledge.

You are NOT a screenplay writer.

You are NOT a video editor.

Do NOT write narration.

Do NOT generate recap scripts.

Do NOT select movie shots.

Your output will be consumed by another AI that writes the recap script.

--------------------------------------------------

# INPUT

You will receive:

- Movie title
- Movie duration
- Full transcript
- Transcript timestamps

The transcript is already ordered chronologically.

--------------------------------------------------

# OBJECTIVE

Analyze the entire movie and extract its complete story structure.

Your analysis should identify:

- overall story
- major acts
- important events
- timeline
- characters
- relationships
- emotional progression
- major reveals
- plot twists
- climax
- ending

The output must preserve chronological order.

Do not invent facts.

Only use information from the transcript.

--------------------------------------------------

# STORY STRUCTURE

Internally identify:

- Introduction
- Inciting Incident
- Rising Action
- Midpoint
- Major Turning Point
- Climax
- Resolution

Use these to organize the movie.

--------------------------------------------------

# CHARACTERS

Extract every important character.

For each character provide:

- id
- name
- role
- short description

Example

{
    "id":"CHAR_001",
    "name":"John",
    "role":"Protagonist",
    "description":"A poor student who dreams of becoming a knight."
}

--------------------------------------------------

# EVENTS

Extract all important story events.

Ignore:

- repeated dialogue
- filler conversations
- long walking scenes
- repeated reactions
- insignificant actions

Keep:

- important decisions
- discoveries
- conflicts
- emotional moments
- battles
- deaths
- betrayals
- reunions
- endings

--------------------------------------------------

# EVENT RULES

Each event should contain exactly one logical story event.

Good:

John meets Mary.

John discovers the treasure.

John defeats the monster.

Bad:

John goes to school,
meets Mary,
then returns home.

These should be separate events.

--------------------------------------------------

# EVENT FIELDS

Each event must contain:

- eventId
- title
- summary
- window
- importance
- emotion
- involvedCharacters

Window represents the approximate movie time.

Example

{
    "from":840,
    "to":930
}

Do NOT return shot ids.

--------------------------------------------------

# IMPORTANCE

Assign importance

1~10

Guide

1

Very minor

3

Background information

5

Normal story progression

7

Important event

9

Major turning point

10

Climax or plot twist

--------------------------------------------------

# EMOTION

Choose ONE

calm

happy

mystery

sad

suspense

action

tense

horror

emotional

climax

--------------------------------------------------

# STORY ACTS

Group events into story acts.

Each act contains:

- actId
- title
- summary
- from
- to
- eventIds

--------------------------------------------------

# MOVIE SUMMARY

Generate one concise summary.

Maximum 250 words.

The summary should explain:

- who the protagonist is
- what they want
- the central conflict
- how the story ends

--------------------------------------------------

# OUTPUT FORMAT

Return JSON only.

{
    "movieTitle":"",

    "movieSummary":"",

    "characters":[

        {
            "id":"CHAR_001",
            "name":"John",
            "role":"Protagonist",
            "description":"..."
        }

    ],

    "storyActs":[

        {
            "actId":"ACT_001",

            "title":"Introduction",

            "summary":"...",

            "from":0,

            "to":1200,

            "eventIds":[
                "EV_001",
                "EV_002"
            ]
        }

    ],

    "events":[

        {

            "eventId":"EV_001",

            "title":"John Meets Mary",

            "summary":"John meets Mary for the first time at school.",

            "window":{

                "from":340,

                "to":410

            },

            "importance":6,

            "emotion":"happy",

            "involvedCharacters":[

                "CHAR_001",

                "CHAR_002"

            ]

        }

    ]

}

--------------------------------------------------

# OUTPUT RULES

Return valid JSON only.

Do NOT output Markdown.

Do NOT write narration.

Do NOT generate recap.

Do NOT select movie shots.

Do NOT explain your reasoning.

Return only the JSON object."""


def _clamp_importance(v: Any) -> int:
    try:
        n = int(round(float(v)))
    except Exception:
        n = 5
    return max(1, min(10, n))


def _normalize_emotion(v: Any) -> str:
    s = str(v or "calm").strip().lower()
    if s in EMOTIONS:
        return s
    aliases = {
        "suspenseful": "suspense",
        "scary": "horror",
        "fear": "horror",
        "joy": "happy",
        "angry": "tense",
        "anger": "tense",
        "neutral": "calm",
        "dramatic": "emotional",
    }
    return aliases.get(s, "calm")


def _event_window(raw: Any, movie_dur: float) -> dict[str, float]:
    if isinstance(raw, list) and len(raw) >= 2:
        a, b = float(raw[0]), float(raw[1])
    elif isinstance(raw, dict):
        a = float(raw.get("from", raw.get("fromSec", raw.get("start", 0))) or 0)
        b = float(raw.get("to", raw.get("toSec", raw.get("end", a + 30))) or (a + 30))
    else:
        a, b = 0.0, min(30.0, movie_dur)
    a = max(0.0, min(movie_dur, a))
    b = max(0.0, min(movie_dur, b))
    if b <= a:
        b = min(movie_dur, a + 30.0)
    return {"from": round(a, 1), "to": round(b, 1)}


def canonicalize_story_knowledge(
    raw: dict[str, Any],
    *,
    movie_title: str,
    movie_dur: float,
) -> dict[str, Any]:
    """Normalize Gemini A-1 output → stable story_knowledge schema."""
    chars_in = raw.get("characters") if isinstance(raw.get("characters"), list) else []
    characters: list[dict[str, Any]] = []
    char_ids: set[str] = set()
    for i, c in enumerate(chars_in):
        if not isinstance(c, dict):
            continue
        cid = str(c.get("id") or f"CHAR_{i + 1:03d}").strip() or f"CHAR_{i + 1:03d}"
        if cid in char_ids:
            cid = f"CHAR_{i + 1:03d}"
        char_ids.add(cid)
        characters.append(
            {
                "id": cid,
                "name": str(c.get("name") or f"Character {i + 1}").strip(),
                "role": str(c.get("role") or "Supporting").strip(),
                "description": str(c.get("description") or "").strip(),
            }
        )

    events_in = raw.get("events") if isinstance(raw.get("events"), list) else []
    events: list[dict[str, Any]] = []
    event_ids: set[str] = set()
    for i, e in enumerate(events_in):
        if not isinstance(e, dict):
            continue
        eid = str(e.get("eventId") or e.get("id") or f"EV_{i + 1:03d}").strip()
        if not eid or eid in event_ids:
            eid = f"EV_{i + 1:03d}"
        event_ids.add(eid)
        involved = e.get("involvedCharacters") or e.get("characters") or []
        if not isinstance(involved, list):
            involved = []
        involved_ids = [str(x) for x in involved if str(x) in char_ids]
        events.append(
            {
                "eventId": eid,
                "title": str(e.get("title") or f"Event {i + 1}").strip(),
                "summary": str(e.get("summary") or e.get("description") or "").strip(),
                "window": _event_window(e.get("window"), movie_dur),
                "importance": _clamp_importance(e.get("importance")),
                "emotion": _normalize_emotion(e.get("emotion")),
                "involvedCharacters": involved_ids,
            }
        )

    events.sort(key=lambda e: float(e["window"]["from"]))
    # Re-stable ids if empty after filter
    if not events:
        return heuristic_story_knowledge(movie_title=movie_title, movie_dur=movie_dur, transcript_summary=[])

    known = {e["eventId"] for e in events}
    acts_in = raw.get("storyActs") if isinstance(raw.get("storyActs"), list) else []
    story_acts: list[dict[str, Any]] = []
    for i, a in enumerate(acts_in):
        if not isinstance(a, dict):
            continue
        aid = str(a.get("actId") or a.get("id") or f"ACT_{i + 1:03d}").strip()
        eids = [str(x) for x in (a.get("eventIds") or []) if str(x) in known]
        af = float(a.get("from", 0) or 0)
        at = float(a.get("to", movie_dur) or movie_dur)
        af = max(0.0, min(movie_dur, af))
        at = max(af, min(movie_dur, at))
        if not eids and events:
            # fill by window overlap
            for e in events:
                if e["window"]["to"] < af or e["window"]["from"] > at:
                    continue
                eids.append(e["eventId"])
        story_acts.append(
            {
                "actId": aid or f"ACT_{i + 1:03d}",
                "title": str(a.get("title") or f"Act {i + 1}").strip(),
                "summary": str(a.get("summary") or "").strip(),
                "from": round(af, 1),
                "to": round(at, 1),
                "eventIds": eids,
            }
        )

    if not story_acts:
        story_acts = [
            {
                "actId": "ACT_001",
                "title": "Full Story",
                "summary": str(raw.get("movieSummary") or "")[:400],
                "from": 0.0,
                "to": round(movie_dur, 1),
                "eventIds": [e["eventId"] for e in events],
            }
        ]

    summary = str(raw.get("movieSummary") or raw.get("summary") or "").strip()
    if len(summary.split()) > 250:
        summary = " ".join(summary.split()[:250])

    return {
        "movieTitle": str(raw.get("movieTitle") or movie_title).strip() or movie_title,
        "movieSummary": summary,
        "characters": characters,
        "storyActs": story_acts,
        "events": events,
    }


def heuristic_story_knowledge(
    *,
    movie_title: str,
    movie_dur: float,
    transcript_summary: list[Any],
    semantic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Fallback when Gemini A-1 fails: sparse events from ASR windows / scenes."""
    events: list[dict[str, Any]] = []
    scenes = (semantic or {}).get("scenes") or []
    if scenes:
        step = max(1, len(scenes) // 16)
        for i, sc in enumerate(scenes[::step][:24]):
            a = float(sc.get("startSec") or 0)
            b = float(sc.get("endSec") or a + 30)
            events.append(
                {
                    "eventId": f"EV_{i + 1:03d}",
                    "title": f"Scene {i + 1}",
                    "summary": f"Story continues around {int(a)}s–{int(b)}s.",
                    "window": _event_window({"from": a, "to": b}, movie_dur),
                    "importance": 5,
                    "emotion": "calm",
                    "involvedCharacters": [],
                }
            )
    elif transcript_summary:
        for i, row in enumerate(transcript_summary[:24]):
            if not isinstance(row, (list, tuple)) or len(row) < 2:
                continue
            a, b = float(row[0]), float(row[1])
            text = str(row[2]) if len(row) > 2 else ""
            events.append(
                {
                    "eventId": f"EV_{i + 1:03d}",
                    "title": f"Moment {i + 1}",
                    "summary": (text or f"Events around {int(a)}s.")[:220],
                    "window": _event_window({"from": a, "to": b}, movie_dur),
                    "importance": 5,
                    "emotion": "calm",
                    "involvedCharacters": [],
                }
            )
    else:
        n = max(8, int(movie_dur / 300))
        for i in range(n):
            a = movie_dur * (i / n)
            b = movie_dur * ((i + 1) / n)
            events.append(
                {
                    "eventId": f"EV_{i + 1:03d}",
                    "title": f"Segment {i + 1}",
                    "summary": f"Story progression in {movie_title}.",
                    "window": _event_window({"from": a, "to": b}, movie_dur),
                    "importance": 5,
                    "emotion": "calm",
                    "involvedCharacters": [],
                }
            )

    return {
        "movieTitle": movie_title,
        "movieSummary": f"{movie_title}: a story reconstructed from available transcript cues.",
        "characters": [],
        "storyActs": [
            {
                "actId": "ACT_001",
                "title": "Full Story",
                "summary": f"Chronological outline of {movie_title}.",
                "from": 0.0,
                "to": round(movie_dur, 1),
                "eventIds": [e["eventId"] for e in events],
            }
        ],
        "events": events,
    }


def generate_story_knowledge(
    payload: dict[str, Any],
    *,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
    movie_title: str = "",
    movie_dur: float = 3600.0,
    transcript_summary: list[Any] | None = None,
    semantic: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = _generate_json(
        SYSTEM_A1,
        payload,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag="gemini_a1",
    )
    title = movie_title or str(payload.get("movieTitle") or "Movie")
    dur = float(payload.get("movieDuration") or movie_dur)
    if result.get("events") or result.get("storyActs"):
        knowledge = canonicalize_story_knowledge(result, movie_title=title, movie_dur=dur)
        if knowledge.get("events"):
            return knowledge
    LOG.warning("CallA-1 invalid or empty; using heuristic story knowledge")
    return heuristic_story_knowledge(
        movie_title=title,
        movie_dur=dur,
        transcript_summary=transcript_summary or [],
        semantic=semantic,
    )


def attach_candidate_shots(
    knowledge: dict[str, Any],
    *,
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    transcript_segments: list[dict[str, Any]] | None = None,
    limit: int = 20,
    pad: float = 12.0,
) -> dict[str, Any]:
    """Attach candidate_shots per event from window overlap (no model shot ids)."""
    events = knowledge.get("events") or []
    used: set[int] = set()
    for ev in events:
        if not isinstance(ev, dict):
            continue
        win = ev.get("window") or {}
        a = float(win.get("from", 0))
        b = float(win.get("to", a + 30))
        need = max(8.0, b - a)
        cands = shortlist_shots(
            shots=shots,
            semantic=semantic,
            movie_range=(a, b),
            need_sec=need,
            limit=limit,
            exclude=set(),
            pad=pad,
            transcript_segments=transcript_segments,
        )
        # Light text boost using event title/summary vs subtitle
        q = f"{ev.get('title', '')} {ev.get('summary', '')}".lower()
        tokens = set(re.findall(r"[a-zA-ZÀ-ỹ0-9]{3,}", q))
        boosted: list[dict[str, Any]] = []
        for c in cands:
            score = float(c.get("score") or 0)
            sub = str(c.get("subtitle") or "").lower()
            if tokens and sub:
                hit = sum(1 for t in tokens if t in sub)
                score += 0.05 * hit
            item = {
                "shot_id": int(c["id"]),
                "score": round(score, 3),
                "startSec": c.get("startSec"),
                "endSec": c.get("endSec"),
                "durationSec": c.get("durationSec"),
                "subtitle": c.get("subtitle") or "",
            }
            boosted.append(item)
        boosted.sort(key=lambda x: float(x["score"]), reverse=True)
        ev["candidate_shots"] = boosted[:limit]
        # soft diversity across events
        for item in boosted[:3]:
            used.add(int(item["shot_id"]))
    return knowledge


def build_a1_payload(
    *,
    movie_title: str,
    movie_duration: float,
    transcript: str,
) -> dict[str, Any]:
    return {
        "movieTitle": movie_title,
        "movieDuration": int(round(movie_duration)),
        "transcript": transcript,
        "transcriptTimestamps": "chronological (embedded in transcript)",
    }
