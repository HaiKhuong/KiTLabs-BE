"""CallA-1 — Story Analyst: SRT → film analysis markdown + derived story knowledge."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

from asr import parse_srt_time_range, sec_to_srt_timestamp
from cluster import shortlist_shots
from gemini_recap import _generate_text

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

Bạn là chuyên gia phân tích phim (movie analyst) cho kênh recap.

Nhiệm vụ: đọc TOÀN BỘ phụ đề SRT và viết bản phân tích phim.

Bạn KHÔNG viết kịch bản thuyết minh recap.
Bạn KHÔNG chọn shot / không dựng video.
Bạn KHÔNG bịa tình tiết không có trong SRT.

Đầu ra sẽ được một writer khác dùng để viết recap.

--------------------------------------------------

# INPUT

JSON gồm:

- movieTitle
- movieDurationSec
- videoFileName
- srt — phụ đề SubRip (index, timestamp HH:MM:SS,mmm --> HH:MM:SS,mmm, text)

Mọi mốc thời gian PHẢI copy đúng timestamp SRT (mili-giây, dấu phẩy).

--------------------------------------------------

# OUTPUT

Chỉ Markdown tiếng Việt, đúng 5 mục (giữ nguyên tiêu đề). Không JSON.

## I. Nhận diện cơ bản
- Tên tác phẩm: ...
- Phạm vi phụ đề: <cue đầu --> cue cuối>
- Nguồn video: Video 1: <videoFileName> (<phạm vi phụ đề>)
- Xác nhận từ tìm kiếm web: Không có
- Tình tiết thực tế trong phụ đề:
  1. ...
  2. ... (5–8 ý, theo diễn biến, không filler)
- Thông tin chưa diễn ra: ... (nếu SRT hé lộ kế hoạch chưa xảy ra; không thì "Không có")

## II. Nhân vật & Mối quan hệ
| Tên thống nhất (Hán Việt) | Tên trong phụ đề | Thân phận / Quan hệ | Động cơ / Lập trường hiện tại | Độ xác thực |
|---|---|---|---|---|
| ... | alias1, alias2 | ... | ... | Phụ đề xác nhận |

Chỉ nhân vật quan trọng. "Độ xác thực" = "Phụ đề xác nhận" trừ khi tên suy luận.

## III. Tóm tắt cốt truyện tổng thể
Một đoạn 180–350 chữ: nhân vật chính, mục tiêu, xung đột, cao trào, kết.

## IV. Phân tích chi tiết từng phân đoạn
| Video | Mốc thời gian (Timestamp) | Chủ đề đoạn | Sự kiện diễn ra | Chức năng tự sự |
|---|---|---|---|---|
| <videoFileName> | 00:00:01,200 --> 00:00:23,556 | ... | ... | Mở màn / Đẩy cao trào / Cao trào / Chuyển hướng / Kết thúc |

Quy tắc:
- Gom cue SRT thành cảnh truyện (không từng câu thoại).
- from/to phải khớp cue SRT thật.
- 12–28 hàng, phủ gần hết phim, thứ tự thời gian, không chồng lấn.

## V. Trọng tâm sáng tác thuyết minh
- Câu mở đầu (Hook): một câu móc (chưa viết full script)
- Xung đột cốt lõi: ...
- Chuyển biến cảm xúc / Đột biến tình thế: list 3–5 ý
- Phân cảnh đắt giá / Lời thoại nổi bật: 3–5 ý, mỗi ý kèm timestamp SRT
- Điểm giữ chân khán giả: ...
- Đoạn âm thanh gốc đề xuất giữ lại: 3–6 khoảng timestamp + lý do ngắn

--------------------------------------------------

# OUTPUT RULES

Chỉ Markdown.
Không viết narrations recap.
Không chọn shot id.
Không bịa nhân vật/sự kiện ngoài SRT.
"""

_SECTION_RE = re.compile(r"^##\s+([IVX]+)\.\s*.+$", re.M)
_TABLE_SEP_RE = re.compile(r"^\s*\|?\s*-{2,}")


def _split_md_sections(markdown: str) -> dict[str, str]:
    matches = list(_SECTION_RE.finditer(markdown or ""))
    out: dict[str, str] = {}
    for i, match in enumerate(matches):
        start = match.end()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(markdown)
        out[match.group(1)] = markdown[start:end].strip()
    return out


def _bullet_after(label: str, text: str) -> str:
    pattern = rf"(?:^|\n)\s*[-*]?\s*{re.escape(label)}\s*:\s*(.+?)(?=\n\s*[-*]?\s*[A-ZÀ-Ỹa-zà-ỹ].*?:|\n##|\Z)"
    match = re.search(pattern, text, re.S | re.I)
    if not match:
        return ""
    return match.group(1).strip()


def _numbered_items(text: str) -> list[str]:
    return [m.group(1).strip() for m in re.finditer(r"^\s*\d+\.\s+(.+)$", text, re.M)]


def _parse_md_table(section: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in (section or "").splitlines():
        raw = line.strip()
        if "|" not in raw:
            continue
        if _TABLE_SEP_RE.match(raw.replace("|", " | ")):
            continue
        cells = [c.strip() for c in raw.strip("|").split("|")]
        if not cells or all(not c or set(c) <= {"-", ":"} for c in cells):
            continue
        rows.append(cells)
    if rows and any("tên" in c.lower() or "video" in c.lower() or "timestamp" in c.lower() for c in rows[0]):
        rows = rows[1:]
    return rows


def _importance_from_function(text: str) -> tuple[int, str]:
    t = (text or "").lower()
    if "cao trào" in t or "climax" in t:
        return 9, "climax"
    if "kết thúc" in t or "ending" in t:
        return 8, "emotional"
    if "mở màn" in t or "inciting" in t:
        return 7, "suspense"
    if "đẩy cao" in t or "rising" in t:
        return 7, "tense"
    if "chuyển" in t:
        return 6, "mystery"
    return 6, "calm"


def parse_story_analysis_markdown(
    markdown: str,
    *,
    movie_title: str,
    movie_dur: float,
    video_name: str = "",
) -> dict[str, Any]:
    """Turn review-style markdown into pipeline story_knowledge."""
    sections = _split_md_sections(markdown)
    ident = sections.get("I") or ""
    chars_sec = sections.get("II") or ""
    summary_sec = sections.get("III") or ""
    segs_sec = sections.get("IV") or ""
    focus_sec = sections.get("V") or ""

    title_m = re.search(r"Tên tác phẩm:\s*(.+)", ident)
    title = (title_m.group(1).strip() if title_m else "") or movie_title
    plot_facts = _numbered_items(ident)
    unrevealed_m = re.search(r"Thông tin chưa diễn ra:\s*(.+)", ident)
    unrevealed = unrevealed_m.group(1).strip() if unrevealed_m else ""

    characters: list[dict[str, Any]] = []
    char_ids: set[str] = set()
    for i, cells in enumerate(_parse_md_table(chars_sec)):
        name = cells[0] if cells else f"Character {i + 1}"
        aliases = cells[1] if len(cells) > 1 else ""
        role = cells[2] if len(cells) > 2 else ""
        motive = cells[3] if len(cells) > 3 else ""
        confidence = cells[4] if len(cells) > 4 else ""
        cid = f"CHAR_{i + 1:03d}"
        char_ids.add(cid)
        characters.append(
            {
                "id": cid,
                "name": name,
                "aliases": aliases,
                "role": role,
                "description": motive,
                "confidence": confidence,
            }
        )

    events: list[dict[str, Any]] = []
    for i, cells in enumerate(_parse_md_table(segs_sec)):
        ts_cell = cells[1] if len(cells) > 1 else ""
        rng = parse_srt_time_range(ts_cell)
        if rng is None:
            continue
        topic = cells[2] if len(cells) > 2 else f"Segment {i + 1}"
        summary = cells[3] if len(cells) > 3 else ""
        function = cells[4] if len(cells) > 4 else ""
        importance, emotion = _importance_from_function(function)
        events.append(
            {
                "eventId": f"EV_{i + 1:03d}",
                "title": topic.strip() or f"Event {i + 1}",
                "summary": summary.strip(),
                "narrativeFunction": function.strip(),
                "window": _event_window({"from": rng[0], "to": rng[1]}, movie_dur),
                "importance": importance,
                "emotion": emotion,
                "involvedCharacters": [],
            }
        )

    events.sort(key=lambda e: float(e["window"]["from"]))
    story_acts = [
        {
            "actId": "ACT_001",
            "title": "Full Story",
            "summary": (summary_sec or "")[:400],
            "from": 0.0,
            "to": round(movie_dur, 1),
            "eventIds": [e["eventId"] for e in events],
        }
    ]
    summary = re.sub(r"\s+", " ", (summary_sec or "").strip())
    if len(summary.split()) > 400:
        summary = " ".join(summary.split()[:400])

    hook = _bullet_after("Câu mở đầu (Hook)", focus_sec) or _bullet_after("Hook", focus_sec)
    conflict = _bullet_after("Xung đột cốt lõi", focus_sec)
    retention = _bullet_after("Điểm giữ chân khán giả", focus_sec)

    return {
        "movieTitle": title,
        "movieSummary": summary,
        "characters": characters,
        "storyActs": story_acts,
        "events": events,
        "plotFacts": plot_facts,
        "unrevealed": unrevealed,
        "videoFileName": video_name,
        "creativeFocus": {
            "hook": hook,
            "coreConflict": conflict,
            "retention": retention,
            "sectionMarkdown": focus_sec,
        },
    }


def analysis_markdown_from_knowledge(
    knowledge: dict[str, Any],
    *,
    video_name: str = "",
    movie_dur: float = 0.0,
) -> str:
    """Fallback markdown when Gemini fails — same 5-section shape."""
    title = str(knowledge.get("movieTitle") or "Untitled")
    video = video_name or str(knowledge.get("videoFileName") or title)
    events = [e for e in (knowledge.get("events") or []) if isinstance(e, dict)]
    if events:
        span = (
            f"{sec_to_srt_timestamp(float(events[0]['window']['from']))} --> "
            f"{sec_to_srt_timestamp(float(events[-1]['window']['to']))}"
        )
    else:
        span = f"00:00:00,000 --> {sec_to_srt_timestamp(movie_dur)}"
    facts = knowledge.get("plotFacts") or [
        e.get("summary") or e.get("title") for e in events[:8]
    ]
    fact_lines = "\n".join(f"  {i + 1}. {x}" for i, x in enumerate(facts) if x)
    chars = knowledge.get("characters") or []
    char_rows = ["| Tên thống nhất (Hán Việt) | Tên trong phụ đề | Thân phận / Quan hệ | Động cơ / Lập trường hiện tại | Độ xác thực |", "|---|---|---|---|---|"]
    if chars:
        for c in chars:
            char_rows.append(
                f"| {c.get('name','')} | {c.get('aliases') or c.get('name','')} | {c.get('role','')} | {c.get('description','')} | {c.get('confidence') or 'Phụ đề xác nhận'} |"
            )
    else:
        char_rows.append("| (chưa tách được) | | | Heuristic từ phụ đề | Suy luận |")
    seg_rows = [
        "| Video | Mốc thời gian (Timestamp) | Chủ đề đoạn | Sự kiện diễn ra | Chức năng tự sự |",
        "|---|---|---|---|---|",
    ]
    for e in events:
        win = e.get("window") or {}
        ts = f"{sec_to_srt_timestamp(float(win.get('from') or 0))} --> {sec_to_srt_timestamp(float(win.get('to') or 0))}"
        seg_rows.append(
            f"| {video} | {ts} | {e.get('title','')} | {e.get('summary','')} | {e.get('narrativeFunction') or e.get('emotion') or ''} |"
        )
    focus = knowledge.get("creativeFocus") or {}
    return "\n".join(
        [
            "## I. Nhận diện cơ bản",
            f"- Tên tác phẩm: {title}",
            f"- Phạm vi phụ đề: {span}",
            f"- Nguồn video: Video 1: {video} ({span})",
            "- Xác nhận từ tìm kiếm web: Không có",
            "- Tình tiết thực tế trong phụ đề:",
            fact_lines or "  1. (thiếu dữ liệu phụ đề)",
            f"- Thông tin chưa diễn ra: {knowledge.get('unrevealed') or 'Không có'}",
            "",
            "## II. Nhân vật & Mối quan hệ",
            *char_rows,
            "",
            "## III. Tóm tắt cốt truyện tổng thể",
            str(knowledge.get("movieSummary") or ""),
            "",
            "## IV. Phân tích chi tiết từng phân đoạn",
            *seg_rows,
            "",
            "## V. Trọng tâm sáng tác thuyết minh",
            f"- Câu mở đầu (Hook): {focus.get('hook') or ''}",
            f"- Xung đột cốt lõi: {focus.get('coreConflict') or ''}",
            f"- Điểm giữ chân khán giả: {focus.get('retention') or ''}",
            str(focus.get("sectionMarkdown") or "").strip(),
        ]
    ).strip() + "\n"


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
    return {"from": round(a, 3), "to": round(b, 3)}


def canonicalize_story_knowledge(
    raw: dict[str, Any],
    *,
    movie_title: str,
    movie_dur: float,
) -> dict[str, Any]:
    """Normalize leftover JSON A-1 output → stable story_knowledge schema."""
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
        "plotFacts": [],
        "creativeFocus": {},
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
) -> tuple[dict[str, Any], str]:
    """Returns (story_knowledge, analysis markdown)."""
    md = _generate_text(
        SYSTEM_A1,
        payload,
        model=model,
        key_tier=key_tier,
        debug_dir=debug_dir,
        debug_tag="gemini_a1",
    )
    title = movie_title or str(payload.get("movieTitle") or "Movie")
    dur = float(payload.get("movieDurationSec") or payload.get("movieDuration") or movie_dur)
    video_name = str(payload.get("videoFileName") or title)
    parsed = parse_story_analysis_markdown(md, movie_title=title, movie_dur=dur, video_name=video_name)
    if parsed.get("events"):
        parsed["videoFileName"] = video_name
        return parsed, md if md.strip() else analysis_markdown_from_knowledge(
            parsed, video_name=video_name, movie_dur=dur
        )
    LOG.warning("CallA-1 invalid or empty; using heuristic story knowledge")
    knowledge = heuristic_story_knowledge(
        movie_title=title,
        movie_dur=dur,
        transcript_summary=transcript_summary or [],
        semantic=semantic,
    )
    knowledge["videoFileName"] = video_name
    fallback_md = analysis_markdown_from_knowledge(knowledge, video_name=video_name, movie_dur=dur)
    return knowledge, fallback_md


def attach_candidate_shots(
    knowledge: dict[str, Any],
    *,
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    transcript_segments: list[dict[str, Any]] | None = None,
    limit: int = 20,
    pad: float = 12.0,
    embeddings: dict[int, list[float]] | None = None,
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
        q = f"{ev.get('title', '')} {ev.get('summary', '')}"
        cands = shortlist_shots(
            shots=shots,
            semantic=semantic,
            movie_range=(a, b),
            need_sec=need,
            limit=limit,
            exclude=set(),
            pad=pad,
            transcript_segments=transcript_segments,
            query_text=q,
            embeddings=embeddings,
        )
        # Light text boost using event title/summary vs subtitle
        q_l = q.lower()
        tokens = set(re.findall(r"[a-zA-ZÀ-ỹ0-9]{3,}", q_l))
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
                "sceneGroupId": c.get("sceneGroupId"),
                "source": c.get("source") or "primary",
            }
            boosted.append(item)
        boosted.sort(key=lambda x: float(x["score"]), reverse=True)
        ev["candidate_shots"] = boosted[:limit]
        for item in boosted[:3]:
            used.add(int(item["shot_id"]))
    return knowledge


def build_a1_payload(
    *,
    movie_title: str,
    movie_duration: float,
    srt: str,
    video_file_name: str = "",
) -> dict[str, Any]:
    return {
        "movieTitle": movie_title,
        "movieDurationSec": int(round(movie_duration)),
        "videoFileName": video_file_name or movie_title,
        "srt": srt,
    }
