from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.gemini")

# Canonical field names (Gemini + script.json + FE)
SCRIPT_TITLE = "title"
SCRIPT_DURATION_SEC = "durationSec"
SCRIPT_NARRATIONS = "narrations"
SCRIPT_RECAP_TIMELINE = "recapTimelineRanges"
SCRIPT_MOVIE_WINDOWS = "movieSourceWindows"

PICKS_SELECTED_SHOTS = "selectedShotsBySegment"


def _env_int(name: str, default: int) -> int:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    # tolerate inline comments / stray chars: take leading integer token
    m = re.match(r"[-+]?\d+", raw)
    if not m:
        LOG.warning("%s=%r không phải số nguyên; dùng default %d", name, raw, default)
        return default
    try:
        return int(m.group(0))
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    raw = (os.environ.get(name) or "").strip()
    if not raw:
        return default
    m = re.match(r"[-+]?\d*\.?\d+", raw)
    if not m:
        LOG.warning("%s=%r không phải số; dùng default %s", name, raw, default)
        return default
    try:
        return float(m.group(0))
    except ValueError:
        return default


# Transient API errors — single retry after debounce (avoid spam)
_RETRY_MAX = _env_int("RECAP_GEMINI_RETRY_MAX", 1)  # retries after first fail
_RETRY_DEBOUNCE_SEC = _env_float("RECAP_GEMINI_RETRY_DEBOUNCE_SEC", 3.0)
_TRANSIENT_MARKERS = (
    "503",
    "429",
    "UNAVAILABLE",
    "RESOURCE_EXHAUSTED",
    "high demand",
    "try again",
    "timeout",
    "temporar",
    "overloaded",
)

# Deprecated: pipeline v2 uses call_a1_story_analyst + call_a2_script_writer.
# Kept for emergency rollback / older debug dumps only.
SYSTEM_A = """# ROLE

You are an expert movie recap writer.

Your task is NOT to edit videos.
Your task is ONLY to understand the entire movie transcript and produce a concise, engaging movie recap script.

The recap should sound like a professional YouTube movie recap channel.

---

# INPUT

You receive JSON with:
- movie.title, movie.durationSec (source film duration in seconds)
- language — write narrations[] in this language
- wordsPerMinute — TTS pacing
- recapTarget.totalDurationRange — target recap duration [minSec, maxSec] on OUTPUT video
- recapTarget.segmentDurationRange — target per-segment length on recap timeline [minSec, maxSec]
- recapTarget.storyBeats — beats on recap timeline: [beatName, startSec, endSec]
- transcript — full chronological transcript with timestamps (HH:MM:SS then text)

---

# GOAL

Compress the movie into approximately recapTarget.totalDurationRange of narration.

Focus only on important events. Ignore filler. Preserve story flow, twists, climax, ending.
Narration must be chronological. Do not invent facts — only use the transcript.

Before writing, internally identify: Introduction, Inciting Incident, Rising Action, Midpoint, Climax, Resolution.

---

# NARRATION RULES

Each narrations[i] should be natural, exciting, present tense, no unnecessary quoted dialogue.
Target recapTarget.segmentDurationRange per segment on the RECAP output timeline.

---

# movieSourceWindows RULE

Each narrations[i] maps to an approximate SOURCE movie time range in seconds [fromSec, toSec].
Used later for local shot search. NOT shot IDs. Approximate is OK.

Example: events around minute 20–25 → movieSourceWindows[i] = [1200, 1500]

---

# recapTimelineRanges RULE

Each narrations[i] also occupies a slot on the OUTPUT recap video timeline [startSec, endSec].
- recapTimelineRanges must be contiguous: first startSec=0, each endSec = next startSec
- last endSec = durationSec
- durationSec must fall within recapTarget.totalDurationRange
- word count of narrations[i] ≈ (endSec - startSec) * wordsPerMinute / 60

---

# OUTPUT (mandatory schema — use EXACT field names)

Return valid JSON ONLY. No markdown. No explanation. No extra keys.

{
  "title": "Recap title",
  "durationSec": 1080,
  "narrations": [
    "Segment 1 voiceover text...",
    "Segment 2 voiceover text..."
  ],
  "recapTimelineRanges": [
    [0, 28],
    [28, 55]
  ],
  "movieSourceWindows": [
    [0, 520],
    [520, 1030]
  ]
}

Field meanings:
- title — recap video title
- durationSec — total recap duration in seconds (= last recapTimelineRanges endSec)
- narrations[i] — voiceover text for segment i (ready for TTS)
- recapTimelineRanges[i] — [startSec, endSec] on RECAP output video timeline
- movieSourceWindows[i] — [fromSec, toSec] on SOURCE movie timeline (B-roll search window)

All three arrays MUST have the same length."""

# Deprecated: pipeline v2 uses call_b_shot_planner (Python diversity).
SYSTEM_B = """# ROLE

You are an expert movie editor.

Your task is NOT to write narration. Narration is already finalized.
Your ONLY task is to select the best sequence of candidate shots that visually supports each narration segment.

---

# INPUT

You receive JSON with segments[] — one item per narration segment:

{
  "segmentIndex": 0,
  "narration": "finalized narration text",
  "durationSec": 32,
  "candidates": [
    {
      "id": 125,
      "startSec": 502.1,
      "endSec": 505.3,
      "durationSec": 3.2,
      "subtitle": "Run!",
      "score": 0.91
    }
  ]
}

Candidates are pre-sorted by relevance (score). Do NOT use thumbnail images.

---

# GOAL

For EACH segment, select shots that best visualize the narration.
Chronological order, continuity, no duplicate moments, prefer consecutive shot ids when possible.
Do NOT rewrite narration. Only choose shots.

Combined duration of selected shots ≈ durationSec (±10% acceptable).

---

# OUTPUT (mandatory schema — use EXACT field name)

Return valid JSON ONLY. No markdown. No explanation.

{
  "selectedShotsBySegment": [
    [125, 126, 129],
    [84, 90, 91]
  ]
}

Rules:
- selectedShotsBySegment[i] = ordered shot ids for segments[i]
- every id MUST exist in that segment's candidates
- do NOT include reason, segmentIndex, shots[], or any other keys
- choose enough shots so total duration ≈ durationSec"""


def _load_keys(tier: str = "vip") -> list[str]:
    tier = (tier or "vip").strip().lower()
    if tier in ("normal", "standard"):
        raw = os.environ.get("GEMINI_API_KEY") or ""
    else:
        raw = os.environ.get("GEMINI_API_KEY_VIP") or os.environ.get("GEMINI_API_KEY") or ""
    return [k.strip() for k in raw.split(",") if k.strip()]


def _model_name(override: str = "") -> str:
    return (override or os.environ.get("RECAP_GEMINI_MODEL") or "gemini-2.5-flash").strip()


def _is_transient(err: BaseException) -> bool:
    msg = str(err).lower()
    return any(m.lower() in msg for m in _TRANSIENT_MARKERS)


def _dump_debug(debug_dir: Path | None, name: str, data: Any) -> None:
    if not debug_dir:
        return
    try:
        debug_dir.mkdir(parents=True, exist_ok=True)
        path = debug_dir / name
        if isinstance(data, (dict, list)):
            path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        else:
            path.write_text(str(data or ""), encoding="utf-8")
    except Exception as exc:
        LOG.warning("Failed to write debug %s: %s", name, exc)


def _generate_json(
    system: str,
    user_obj: Any,
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
    debug_tag: str = "gemini",
) -> dict[str, Any]:
    tier = key_tier or os.environ.get("RECAP_GEMINI_KEY_TIER") or "vip"
    keys = _load_keys(tier)
    if not keys:
        LOG.warning("No Gemini keys (tier=%s); using heuristic fallback", tier)
        return {}

    model_id = _model_name(model)
    prompt = system + "\n\n# INPUT JSON\n" + json.dumps(user_obj, ensure_ascii=False)
    _dump_debug(debug_dir, f"{debug_tag}_request.json", user_obj)
    _dump_debug(debug_dir, f"{debug_tag}_prompt.txt", prompt)
    last_err: Exception | None = None

    use_new_sdk = False
    try:
        from google import genai  # type: ignore

        use_new_sdk = True
    except Exception:
        try:
            from google.generativeai import GenerativeModel, configure  # type: ignore
        except Exception as exc:
            LOG.warning("google generative AI SDK missing (%s)", exc)
            return {}

    def _call_once(api_key: str) -> dict[str, Any]:
        raw_text = ""
        if use_new_sdk:
            client = genai.Client(api_key=api_key)
            resp = client.models.generate_content(
                model=model_id,
                contents=prompt,
                config={"response_mime_type": "application/json", "temperature": 0.4},
            )
            raw_text = getattr(resp, "text", None) or ""
        else:
            configure(api_key=api_key)
            m = GenerativeModel(
                model_id,
                generation_config={"response_mime_type": "application/json", "temperature": 0.4},
            )
            resp = m.generate_content(prompt)
            raw_text = resp.text or ""
        _dump_debug(debug_dir, f"{debug_tag}_response_raw.txt", raw_text)
        parsed = _parse_json(raw_text)
        _dump_debug(debug_dir, f"{debug_tag}_response.json", parsed)
        return parsed

    # Each key once. Transient 503/429: debounce 3s then retry once (global, not per key).
    transient_retried = False
    for key in keys:
        try:
            return _call_once(key)
        except Exception as err:
            last_err = err
            transient = _is_transient(err)
            LOG.warning(
                "Gemini key=...%s failed%s: %s",
                key[-4:] if len(key) >= 4 else "????",
                " (transient)" if transient else "",
                err,
            )
            if transient and not transient_retried and _RETRY_MAX >= 1:
                transient_retried = True
                LOG.info("Gemini debounce %.1fs then retry once…", _RETRY_DEBOUNCE_SEC)
                time.sleep(_RETRY_DEBOUNCE_SEC)
                try:
                    return _call_once(key)
                except Exception as retry_err:
                    last_err = retry_err
                    LOG.warning("Gemini retry failed: %s", retry_err)

    if last_err:
        LOG.error("All Gemini attempts failed: %s", last_err)
        _dump_debug(debug_dir, f"{debug_tag}_error.txt", str(last_err))
    return {}


def _parse_json(text: str) -> dict[str, Any]:
    text = (text or "").strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
        if m:
            return json.loads(m.group(1).strip())
        raise


def _estimate_recap_span(text: str, wpm: int, min_sec: float = 15.0, max_sec: float = 40.0) -> float:
    words = len(re.findall(r"\S+", text or ""))
    if words <= 0:
        return min_sec
    sec = words / max(wpm, 80) * 60.0
    return max(min_sec, min(max_sec, sec))


def _pair_list(raw: Any) -> list[list[float]]:
    if not isinstance(raw, list):
        return []
    out: list[list[float]] = []
    for item in raw:
        if isinstance(item, list) and len(item) >= 2:
            out.append([float(item[0]), float(item[1])])
        elif isinstance(item, dict):
            a = item.get("startSec", item.get("fromSec", item.get("from", item.get("start", 0))))
            b = item.get("endSec", item.get("toSec", item.get("to", item.get("end", 0))))
            out.append([float(a), float(b)])
    return out


def canonicalize_script(raw: dict[str, Any], payload: dict[str, Any] | None = None) -> dict[str, Any]:
    """Normalize any Gemini / legacy shape → canonical full field names."""
    payload = payload or {}

    # Legacy short keys {t,d,n,r,m}
    if raw.get("n") and raw.get("r") and raw.get("m"):
        return {
            SCRIPT_TITLE: str(raw.get("t") or raw.get("title") or "Recap"),
            SCRIPT_DURATION_SEC: float(raw.get("d") or raw.get("durationSec") or raw["r"][-1][1]),
            SCRIPT_NARRATIONS: list(raw["n"]),
            SCRIPT_RECAP_TIMELINE: _pair_list(raw["r"]),
            SCRIPT_MOVIE_WINDOWS: _pair_list(raw["m"]),
        }

    # Already canonical
    if raw.get(SCRIPT_NARRATIONS) and raw.get(SCRIPT_RECAP_TIMELINE) and raw.get(SCRIPT_MOVIE_WINDOWS):
        return {
            SCRIPT_TITLE: str(raw.get(SCRIPT_TITLE) or payload.get("movie", {}).get("title") or "Recap"),
            SCRIPT_DURATION_SEC: float(
                raw.get(SCRIPT_DURATION_SEC) or raw[SCRIPT_RECAP_TIMELINE][-1][1]
            ),
            SCRIPT_NARRATIONS: list(raw[SCRIPT_NARRATIONS]),
            SCRIPT_RECAP_TIMELINE: _pair_list(raw[SCRIPT_RECAP_TIMELINE]),
            SCRIPT_MOVIE_WINDOWS: _pair_list(raw[SCRIPT_MOVIE_WINDOWS]),
        }

    wpm = int(payload.get("wordsPerMinute") or payload.get("wpm") or 140)
    tl = payload.get("recapTarget") or payload.get("tl") or {}
    seg_range = tl.get("segmentDurationRange") or tl.get("seg") or [15, 40]
    min_seg = float(seg_range[0]) if seg_range else 15.0
    max_seg = float(seg_range[1]) if len(seg_range) > 1 else 40.0

    segments = raw.get("segments")
    if isinstance(segments, list) and segments:
        narrations: list[str] = []
        movie_windows: list[list[float]] = []
        recap_timeline: list[list[float]] = []
        t_cursor = 0.0
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            narration = str(seg.get("narration") or seg.get("n") or "").strip()
            if not narration:
                continue
            window = seg.get("window") or seg.get("movieSourceWindows") or {}
            if isinstance(window, list) and len(window) >= 2:
                src_from, src_to = float(window[0]), float(window[1])
            else:
                src_from = float(window.get("fromSec", window.get("from", window.get("start", 0))))
                src_to = float(window.get("toSec", window.get("to", window.get("end", src_from + 30))))
            span = _estimate_recap_span(narration, wpm, min_seg, max_seg)
            narrations.append(narration)
            movie_windows.append([round(src_from, 1), round(src_to, 1)])
            recap_timeline.append([round(t_cursor, 1), round(t_cursor + span, 1)])
            t_cursor += span

        if narrations:
            title = str(
                raw.get(SCRIPT_TITLE)
                or raw.get("title")
                or raw.get("t")
                or payload.get("movie", {}).get("title")
                or "Recap"
            )
            return {
                SCRIPT_TITLE: title,
                SCRIPT_DURATION_SEC: round(t_cursor, 1),
                SCRIPT_NARRATIONS: narrations,
                SCRIPT_RECAP_TIMELINE: recap_timeline,
                SCRIPT_MOVIE_WINDOWS: movie_windows,
            }

    return raw


def script_is_valid(script: dict[str, Any]) -> bool:
    return bool(
        script.get(SCRIPT_NARRATIONS)
        and script.get(SCRIPT_RECAP_TIMELINE)
        and script.get(SCRIPT_MOVIE_WINDOWS)
    )


def generate_script(
    payload: dict[str, Any],
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
) -> dict[str, Any]:
    """Deprecated monolith CallA — use call_a1 + call_a2 instead."""
    LOG.warning("generate_script() is deprecated; prefer CallA-1 + CallA-2")
    result = _generate_json(
        SYSTEM_A,
        payload,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag="gemini_a",
    )
    result = canonicalize_script(result, payload)
    if script_is_valid(result):
        return result
    LOG.warning("Gemini A invalid or empty; falling back to heuristic script")
    return _heuristic_script(payload)


def _candidate_ids(candidates: list[Any]) -> list[int]:
    ids: list[int] = []
    for c in candidates:
        if isinstance(c, dict):
            ids.append(int(c["id"]))
        else:
            ids.append(int(c))
    return ids


def expected_segment_count(payload: dict[str, Any]) -> int:
    segments = payload.get("segments") or []
    if segments:
        return len(segments)
    narrations = payload.get("narrations") or payload.get("n") or []
    return len(narrations)


def canonicalize_picks(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize Gemini B response → {selectedShotsBySegment: number[][]}."""
    if isinstance(raw.get(PICKS_SELECTED_SHOTS), list) and raw[PICKS_SELECTED_SHOTS]:
        rows: list[list[int]] = []
        for row in raw[PICKS_SELECTED_SHOTS]:
            if isinstance(row, list):
                rows.append([int(x) for x in row])
        if rows:
            return {PICKS_SELECTED_SHOTS: rows}

    # Legacy short key
    if isinstance(raw.get("s"), list) and raw["s"]:
        rows = [[int(x) for x in row] if isinstance(row, list) else [] for row in raw["s"]]
        rows = [r for r in rows if r]
        if rows:
            return {PICKS_SELECTED_SHOTS: rows}

    rows: list[list[int]] = []

    if isinstance(raw.get("segments"), list):
        for seg in raw["segments"]:
            if not isinstance(seg, dict):
                rows.append([])
                continue
            shots = seg.get("shots") or seg.get("shotIds") or []
            row = []
            for sh in shots:
                if isinstance(sh, dict) and sh.get("id") is not None:
                    row.append(int(sh["id"]))
                elif isinstance(sh, (int, float)):
                    row.append(int(sh))
            rows.append(row)
        if rows:
            return {PICKS_SELECTED_SHOTS: rows}

    if isinstance(raw.get("shots"), list):
        row = []
        for sh in raw["shots"]:
            if isinstance(sh, dict) and sh.get("id") is not None:
                row.append(int(sh["id"]))
            elif isinstance(sh, (int, float)):
                row.append(int(sh))
        if row:
            return {PICKS_SELECTED_SHOTS: [row]}

    return raw


def picks_is_valid(picks: dict[str, Any]) -> bool:
    rows = picks.get(PICKS_SELECTED_SHOTS) or picks.get("s") or []
    return isinstance(rows, list) and any(rows)


def _heuristic_pick_shots(payload: dict[str, Any]) -> dict[str, Any]:
    rows: list[list[int]] = []
    segments = payload.get("segments") or []
    if segments:
        for seg in segments:
            cands = seg.get("candidates") or []
            need = float(seg.get("durationSec") or 30.0)
            if cands:
                ids_by_start = sorted(
                    cands,
                    key=lambda c: float(
                        c.get("startSec", c.get("start", 0)) if isinstance(c, dict) else 0
                    ),
                )
                chron_ids = _candidate_ids(ids_by_start)
                take = max(1, min(len(chron_ids), int(need / 3) + 1))
                rows.append(chron_ids[:take])
            else:
                rows.append([])
        return {PICKS_SELECTED_SHOTS: rows}

    needs = payload.get("need") or []
    cands = payload.get("c") or []
    for i, c in enumerate(cands):
        ids = _candidate_ids(c if isinstance(c, list) else [])
        need = float(needs[i]) if i < len(needs) else 30.0
        take = max(1, min(len(ids), int(need / 3) + 1))
        rows.append(ids[:take])
    while len(rows) < expected_segment_count(payload):
        rows.append([])
    return {PICKS_SELECTED_SHOTS: rows}


def pick_shots(
    payload: dict[str, Any],
    model: str = "",
    key_tier: str = "",
    debug_dir: Path | None = None,
) -> dict[str, Any]:
    """Deprecated Gemini B — use call_b_shot_planner instead."""
    LOG.warning("pick_shots() is deprecated; prefer CallB planner")
    result = _generate_json(
        SYSTEM_B,
        payload,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag="gemini_b",
    )
    result = canonicalize_picks(result)
    if picks_is_valid(result):
        return result
    LOG.warning("Gemini B invalid or empty; falling back to heuristic shot picks")
    return _heuristic_pick_shots(payload)


def validate_script(
    script: dict[str, Any],
    dur_min: int,
    dur_max: int,
    movie_dur: float,
    wpm: int,
) -> None:
    canonical = canonicalize_script(script)
    script.clear()
    script.update(canonical)
    narrations = script[SCRIPT_NARRATIONS]
    recap_timeline = script[SCRIPT_RECAP_TIMELINE]
    movie_windows = script[SCRIPT_MOVIE_WINDOWS]

    if not (len(narrations) == len(recap_timeline) == len(movie_windows) and len(narrations) > 0):
        raise ValueError("narrations / recapTimelineRanges / movieSourceWindows length mismatch or empty")

    if float(recap_timeline[0][0]) > 0.05:
        recap_timeline[0][0] = 0
    for i in range(len(recap_timeline) - 1):
        recap_timeline[i + 1][0] = recap_timeline[i][1]

    script[SCRIPT_DURATION_SEC] = float(recap_timeline[-1][1])
    duration = float(script[SCRIPT_DURATION_SEC])
    if duration < dur_min * 0.85 or duration > dur_max * 1.15:
        LOG.warning("script duration %.1f outside target [%s,%s]", duration, dur_min, dur_max)

    for i, (a, b) in enumerate(movie_windows):
        a = max(0.0, float(a))
        b = min(float(movie_dur), float(b))
        if b <= a:
            b = min(movie_dur, a + 30)
        movie_windows[i] = [a, b]

        span = float(recap_timeline[i][1]) - float(recap_timeline[i][0])
        words = len(re.findall(r"\S+", str(narrations[i])))
        expected = span * wpm / 60.0
        if expected > 0 and abs(words - expected) / expected > 0.35:
            LOG.warning(
                "segment %d word count %d vs expected ~%.0f (span=%.1fs wpm=%d)",
                i,
                words,
                expected,
                span,
                wpm,
            )

    script[SCRIPT_MOVIE_WINDOWS] = movie_windows
    script[SCRIPT_RECAP_TIMELINE] = recap_timeline


def _heuristic_script(payload: dict[str, Any]) -> dict[str, Any]:
    movie = payload.get("movie") or {}
    tl = payload.get("recapTarget") or payload.get("tl") or {}
    total = tl.get("totalDurationRange") or tl.get("total") or [900, 1200]
    target = int((total[0] + total[1]) / 2)
    tr = payload.get("transcriptSummary") or payload.get("tr") or []
    title = str(movie.get("title") or "Movie")
    movie_dur = float(movie.get("durationSec") or movie.get("dur") or 3600)
    lang = str(payload.get("language") or payload.get("lang") or "vi")
    seg_len = 30
    n_segs = max(8, target // seg_len)
    narrations: list[str] = []
    recap_timeline: list[list[float]] = []
    movie_windows: list[list[float]] = []
    t = 0.0

    for i in range(n_segs):
        t1 = min(target, t + seg_len)
        src0 = movie_dur * (i / n_segs)
        src1 = movie_dur * ((i + 1) / n_segs)
        snippet = ""
        for row in tr:
            if len(row) >= 3 and float(row[0]) <= src1 and float(row[1]) >= src0:
                snippet = str(row[2])[:180]
                break
        if lang.startswith("vi"):
            if i == 0:
                text = f"Chào mọi người, hôm nay mình recap nhanh bộ phim {title}."
            elif i == n_segs - 1:
                text = f"Đó là toàn bộ phần recap {title}. Nếu hay thì like và subscribe nhé."
            else:
                text = snippet or f"Tiếp theo trong {title}, câu chuyện tiếp tục phát triển ở đoạn này."
        else:
            if i == 0:
                text = f"Today we recap {title}."
            elif i == n_segs - 1:
                text = f"That wraps up our recap of {title}."
            else:
                text = snippet or f"The story of {title} continues."
        narrations.append(text)
        recap_timeline.append([round(t, 1), round(t1, 1)])
        movie_windows.append([round(src0, 1), round(src1, 1)])
        t = t1
        if t >= target:
            break

    return {
        SCRIPT_TITLE: f"Recap: {title}",
        SCRIPT_DURATION_SEC: recap_timeline[-1][1] if recap_timeline else target,
        SCRIPT_NARRATIONS: narrations,
        SCRIPT_RECAP_TIMELINE: recap_timeline,
        SCRIPT_MOVIE_WINDOWS: movie_windows,
    }
