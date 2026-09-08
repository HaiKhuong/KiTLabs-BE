"""CallB — Shot Planner: match visualBeats → ordered shot ids covering audioDur."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401  — HF cache → ~/.cache/huggingface/hub (trước open_clip/torch)

from clip_embeddings import (
    encode_shot_keyframes,
    encode_texts,
    load_shot_embeddings,
    load_shot_extra_embeddings,
    save_shot_embeddings,
)
from diversity import cosine, mmr_select, score_text_overlap
from gemini_recap import PICKS_SELECTED_SHOTS
from progress_log import progress
from ranking import final_score, quality_score, ranking_config, shot_mid, temporal_score

LOG = logging.getLogger("recap.call_b")

# Bump when pick rules change so work-dir cache does not reuse old picks.json.
PICKS_PLAN_VERSION = 8


def _shot_mid(s: dict[str, Any]) -> float:
    return shot_mid(s)


def _max_clip(
    sid: int,
    text_emb: list[float] | None,
    embeddings: dict[int, list[float]] | None,
    extras: dict[int, list[list[float]]] | None,
) -> float:
    if not text_emb:
        return 0.0
    best = 0.0
    if embeddings and sid in embeddings:
        best = max(best, cosine(text_emb, embeddings[sid]))
    for vec in (extras or {}).get(sid) or []:
        best = max(best, cosine(text_emb, vec))
    return best


def _load_shot_embeddings(
    shots: list[dict[str, Any]],
    work_dir: Path,
) -> tuple[dict[int, list[float]], dict[int, list[list[float]]]]:
    keyframes_dir = work_dir / "keyframes"
    cached = load_shot_embeddings(work_dir, keyframes_dir=keyframes_dir)
    extras = load_shot_extra_embeddings(work_dir) if cached else {}
    if cached:
        return cached, extras
    if not keyframes_dir.exists():
        return {}, {}
    paths: list[tuple[int, Path]] = []
    for s in shots:
        sid = int(s["id"])
        p = keyframes_dir / f"shot_{sid:05d}.jpg"
        if p.exists():
            paths.append((sid, p))
    if not paths:
        return {}, {}
    try:
        out = encode_shot_keyframes(paths)
        if out:
            save_shot_embeddings(work_dir, out)
        return out, {}
    except Exception as exc:
        LOG.warning("CallB: shot embeddings unavailable (%s)", exc)
        return {}, {}


def _expand_near_ids(ids: set[int], radius: int) -> set[int]:
    if radius <= 0:
        return set(ids)
    out: set[int] = set()
    for sid in ids:
        for delta in range(-radius, radius + 1):
            out.add(sid + delta)
    return out


def _prefer_fresh_pool(
    pool: list[dict[str, Any]],
    *,
    blocked_ids: set[int],
    blocked_groups: set[Any],
) -> list[dict[str, Any]]:
    """Drop globally used shots / recent scene groups unless the pool would be empty."""
    unused = [c for c in pool if int(c["id"]) not in blocked_ids]
    source = unused if unused else pool
    if not blocked_groups:
        return source
    diverse = [c for c in source if c.get("sceneGroupId") not in blocked_groups]
    return diverse if len(diverse) >= 2 else source


def _prefer_forward_pool(
    pool: list[dict[str, Any]],
    *,
    cursor: int,
    slack: int = 0,
) -> list[dict[str, Any]]:
    """Keep shots that continue the movie timeline (higher shot id)."""
    if cursor <= 0 or not pool:
        return pool
    strict = [c for c in pool if int(c["id"]) > cursor]
    if len(strict) >= 2:
        return strict
    if strict:
        return strict
    if slack > 0:
        loose = [c for c in pool if int(c["id"]) > cursor - slack]
        if loose:
            return loose
    return pool


def _enrich_candidates(
    candidates: list[dict[str, Any]],
    shots_by_id: dict[int, dict[str, Any]],
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in candidates:
        sid = int(c.get("id", c.get("shot_id") or -1))
        if sid < 0:
            continue
        base = shots_by_id.get(sid) or {}
        out.append(
            {
                "id": sid,
                "shot_id": sid,
                "startSec": float(c.get("startSec") if c.get("startSec") is not None else base.get("startSec") or 0),
                "endSec": float(c.get("endSec") if c.get("endSec") is not None else base.get("endSec") or 0),
                "durationSec": float(
                    c.get("durationSec")
                    if c.get("durationSec") is not None
                    else max(
                        0.1,
                        float(base.get("endSec") or 0) - float(base.get("startSec") or 0),
                    )
                ),
                "subtitle": str(c.get("subtitle") or ""),
                "score": float(c.get("score") or 0),
                "semanticSceneId": base.get("semanticSceneId") or c.get("semanticSceneId"),
                "sceneGroupId": base.get("sceneGroupId", c.get("sceneGroupId")),
                "quality": base.get("quality") if isinstance(base.get("quality"), dict) else {},
            }
        )
    return out


def _shot_duration(shot: dict[str, Any]) -> float:
    if shot.get("durationSec") is not None:
        return max(0.1, float(shot["durationSec"]))
    return max(0.1, float(shot.get("endSec") or 0) - float(shot.get("startSec") or 0))


def _shot_id_bounds(shots: list[dict[str, Any]]) -> tuple[int, int, list[int]]:
    ids = sorted(int(s["id"]) for s in shots if isinstance(s, dict) and s.get("id") is not None)
    if not ids:
        return 0, 0, []
    return ids[0], ids[-1], ids


def _walk_shot_window(
    shots: list[dict[str, Any]],
    *,
    audio_dur: float,
    min_id: int,
    max_id: int,
    used: set[int],
    cfg: dict[str, Any] | None = None,
) -> list[int]:
    """Walk shot ids in order inside [min_id, max_id], skipping as little as possible."""
    rc = ranking_config(cfg)
    max_gap = max(1, int(rc["openingMaxGap"]))
    qmin = float(rc["openingMinQuality"])
    by_id = {int(s["id"]): s for s in shots if isinstance(s, dict) and s.get("id") is not None}
    ordered_ids = [sid for sid in sorted(by_id) if min_id <= sid <= max_id and sid not in used]
    picked: list[int] = []
    total = 0.0
    skipped = 0
    need = max(2, int(round(float(audio_dur) / 4.0)))
    for sid in ordered_ids:
        shot = by_id[sid]
        q = quality_score(shot.get("quality") if isinstance(shot.get("quality"), dict) else None)
        if picked and q < qmin and skipped < max_gap:
            skipped += 1
            continue
        skipped = 0
        picked.append(sid)
        total += _shot_duration(shot)
        if total >= float(audio_dur) * 0.85 and len(picked) >= 2:
            break
        if len(picked) >= need + 2:
            break
    return picked


def _audio_need_sec(tts_meta: list[dict[str, Any]], index: int, fallback: float = 28.0) -> float:
    row = tts_meta[index] if index < len(tts_meta) else {}
    return float(row.get("durationSec") or row.get("audioDur") or fallback)


def _overlaps_window(shot: dict[str, Any], t0: float, t1: float, *, slack: float = 0.0) -> bool:
    s0 = float(shot.get("startSec") or 0)
    s1 = float(shot.get("endSec") or 0)
    if s1 <= s0:
        s1 = s0 + float(shot.get("durationSec") or 0.1)
    return s1 > (t0 - slack) and s0 < (t1 + slack)


def _parse_window(raw: Any) -> tuple[float, float] | None:
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        a, b = float(raw[0]), float(raw[1])
        if b > a:
            return a, b
    if isinstance(raw, dict):
        a = float(raw.get("from") or raw.get("fromSec") or raw.get("start") or 0)
        b = float(raw.get("to") or raw.get("toSec") or raw.get("end") or 0)
        if b > a:
            return a, b
    return None


def _shot_time_span(shots: list[dict[str, Any]]) -> tuple[float, float]:
    if not shots:
        return 0.0, 60.0
    t0 = min(float(s.get("startSec") or 0) for s in shots)
    t1 = max(float(s.get("endSec") or 0) for s in shots)
    if t1 <= t0:
        t1 = t0 + 1.0
    return t0, t1


def _segment_source_window(
    *,
    index: int,
    total: int,
    segment: dict[str, Any] | None,
    events_by_id: dict[str, Any] | None,
    movie_windows: list[Any] | None,
    shots: list[dict[str, Any]],
) -> tuple[float, float]:
    """Movie-time search window for this narration/TTS segment."""
    if movie_windows and 0 <= index < len(movie_windows):
        parsed = _parse_window(movie_windows[index])
        if parsed:
            return parsed
    eids = [str(x) for x in ((segment or {}).get("eventIds") or [])]
    fs: list[float] = []
    ts: list[float] = []
    for eid in eids:
        ev = (events_by_id or {}).get(eid)
        if not isinstance(ev, dict):
            continue
        parsed = _parse_window(ev.get("window"))
        if parsed:
            fs.append(parsed[0])
            ts.append(parsed[1])
    if fs and ts:
        return min(fs), max(ts)
    span0, span1 = _shot_time_span(shots)
    n = max(1, total)
    r0 = max(0, index) / n
    r1 = min(n, index + 1) / n
    return span0 + (span1 - span0) * r0, span0 + (span1 - span0) * r1


def _scoped_shots(
    shots: list[dict[str, Any]],
    *,
    min_id: int | None = None,
    max_id: int | None = None,
    window: tuple[float, float] | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for s in shots:
        if not isinstance(s, dict) or s.get("id") is None:
            continue
        sid = int(s["id"])
        if min_id is not None and sid < int(min_id):
            continue
        if max_id is not None and sid > int(max_id):
            continue
        out.append(s)
    if not out or window is None:
        return out
    t0, t1 = window
    in_win = [s for s in out if _overlaps_window(s, t0, t1)]
    if in_win:
        return in_win
    for pad in (8.0, 20.0, 45.0, 90.0, 180.0):
        in_win = [s for s in out if _overlaps_window(s, t0, t1, slack=pad)]
        if in_win:
            return in_win
    mid = (t0 + t1) / 2.0
    nearest = sorted(out, key=lambda s: abs(_shot_mid(s) - mid))
    near = [s for s in nearest if abs(_shot_mid(s) - mid) <= 120.0]
    return near or nearest[: max(1, min(12, len(nearest)))]


def _reuse_avoid_ids(
    *,
    cursor: int,
    recent_rows: list[list[int]] | None,
    cfg: dict[str, Any] | None = None,
) -> set[int]:
    """Block recently shown shots and ids too close to the current pick cursor."""
    rc = ranking_config(cfg)
    gap = max(0, int(rc["reuseMinIdGap"]))
    cooldown = max(0, int(rc["reuseCooldownSegments"]))
    blocked: set[int] = set()
    rows = recent_rows or []
    for row in rows[-cooldown:]:
        blocked.update(int(x) for x in (row or []) if x is not None)
    if gap > 0 and int(cursor or 0) > 0:
        blocked.update(_expand_near_ids({int(cursor)}, gap))
    return blocked


def _pick_covering(
    scoped: list[dict[str, Any]],
    *,
    audio_dur: float,
    used: set[int],
    cursor: int,
    cfg: dict[str, Any] | None = None,
    allow_reuse: bool = False,
    avoid_near: set[int] | None = None,
) -> list[int]:
    if not scoped:
        return []
    by_id = {int(s["id"]): s for s in scoped}
    ordered = sorted(by_id)
    avoid = set(avoid_near or ())
    skip_used = set(used)

    def walk(allowed: list[int]) -> list[int]:
        if not allowed:
            return []
        allow_set = set(allowed)
        blocked = {sid for sid in by_id if sid not in allow_set}
        return _walk_shot_window(
            [by_id[sid] for sid in allowed],
            audio_dur=audio_dur,
            min_id=min(allowed),
            max_id=max(allowed),
            used=blocked,
            cfg=cfg,
        )

    unused_fwd = [sid for sid in ordered if sid not in skip_used and sid > int(cursor or 0)]
    unused_any = [sid for sid in ordered if sid not in skip_used]
    for group in (unused_fwd, unused_any):
        ids = walk(group)
        if ids:
            return ids
    if allow_reuse:
        far_fwd = [sid for sid in ordered if sid not in avoid and sid > int(cursor or 0)]
        far_any = [sid for sid in ordered if sid not in avoid]
        for group in (far_fwd, far_any):
            ids = walk(group)
            if ids:
                return ids
    return []


def _cover_audio_shots(
    shots: list[dict[str, Any]],
    *,
    audio_dur: float,
    used: set[int],
    cursor: int,
    min_id: int | None = None,
    max_id: int | None = None,
    window: tuple[float, float] | None = None,
    cfg: dict[str, Any] | None = None,
    allow_reuse: bool = False,
    avoid_near: set[int] | None = None,
    recent_rows: list[list[int]] | None = None,
) -> list[int]:
    """Cover TTS duration; reuse old shots only if they are far from the current cursor."""
    if avoid_near is None:
        avoid_near = _reuse_avoid_ids(cursor=cursor, recent_rows=recent_rows, cfg=cfg)

    def pick(pool: list[dict[str, Any]], *, reuse: bool) -> list[int]:
        return _pick_covering(
            pool,
            audio_dur=audio_dur,
            used=used,
            cursor=cursor,
            cfg=cfg,
            allow_reuse=reuse,
            avoid_near=avoid_near,
        )

    window_pool = _scoped_shots(shots, min_id=min_id, max_id=max_id, window=window)
    ids = pick(window_pool, reuse=False)
    if ids:
        return ids
    global_pool = _scoped_shots(shots)
    ids = pick(global_pool, reuse=False)
    if ids:
        return ids
    if allow_reuse:
        ids = pick(window_pool, reuse=True)
        if ids:
            return ids
        ids = pick(global_pool, reuse=True)
        if ids:
            return ids
        # Last resort: farthest from cursor so the row is never empty.
        by_id = {int(s["id"]): s for s in global_pool}
        if by_id:
            farthest = max(by_id, key=lambda sid: abs(sid - int(cursor or 0)))
            return [farthest]
    return []


def _ids_from_candidates(
    candidates: list[dict[str, Any]],
    *,
    used: set[int],
    cursor: int,
    take: int,
) -> list[int]:
    if not candidates or take <= 0:
        return []
    return sorted(
        {
            int(c["id"])
            for c in candidates
            if isinstance(c, dict) and c.get("id") is not None and int(c["id"]) not in used and int(c["id"]) > cursor
        }
    )[:take]


def plan_opening_shots(
    shots: list[dict[str, Any]],
    *,
    audio_dur: float,
    cursor: int,
    used: set[int],
    cfg: dict[str, Any] | None = None,
) -> list[int]:
    """Cover the movie intro: walk shot ids in order, skip as little as possible."""
    rc = ranking_config(cfg)
    frac = min(0.35, max(0.04, float(rc["openingShotFrac"])))
    lo, hi, all_ids = _shot_id_bounds(shots)
    if not all_ids:
        return []
    min_id = int(cursor) + 1 if int(cursor or 0) > 0 else lo
    cap = max(min_id + 20, lo + int((hi - lo + 1) * frac), int(cursor) + 48)
    return _walk_shot_window(shots, audio_dur=audio_dur, min_id=min_id, max_id=cap, used=used, cfg=cfg)


def plan_ending_shots(
    shots: list[dict[str, Any]],
    *,
    audio_dur: float,
    cursor: int,
    used: set[int],
    ending_floor: int,
    cfg: dict[str, Any] | None = None,
) -> list[int]:
    """Cover the movie climax/ending: walk the reserved tail of shot ids."""
    lo, hi, all_ids = _shot_id_bounds(shots)
    if not all_ids:
        return []
    start = ending_floor if int(cursor or 0) < ending_floor else int(cursor) + 1
    start = max(start, lo)
    return _walk_shot_window(shots, audio_dur=audio_dur, min_id=start, max_id=hi, used=used, cfg=cfg)


def plan_shots_for_segment(
    segment: dict[str, Any],
    candidates: list[dict[str, Any]],
    *,
    audio_dur: float,
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    embeddings: dict[int, list[float]] | None = None,
    extras: dict[int, list[list[float]]] | None = None,
    cfg: dict[str, Any] | None = None,
    event_mid: float | None = None,
    debug_rows: list[dict[str, Any]] | None = None,
    avoid_ids: set[int] | None = None,
    avoid_groups: set[Any] | None = None,
    story_cursor: int = 0,
    id_max: int | None = None,
    source_window: tuple[float, float] | None = None,
) -> list[int]:
    """Match visualBeats → diverse ordered shot ids covering ~audio_dur."""
    shots_by_id = {int(s["id"]): s for s in shots}
    pool = _enrich_candidates(candidates, shots_by_id)
    if source_window:
        in_win = [c for c in pool if _overlaps_window(c, source_window[0], source_window[1])]
        if in_win:
            pool = in_win
        else:
            seeded = _enrich_candidates(
                [{"id": int(s["id"])} for s in _scoped_shots(shots, window=source_window)],
                shots_by_id,
            )
            if seeded:
                pool = seeded
    if id_max is not None:
        capped = [
            c
            for c in pool
            if int(c["id"]) <= int(id_max)
            or (source_window is not None and _overlaps_window(c, source_window[0], source_window[1]))
        ]
        if capped:
            pool = capped
    if not pool:
        return []

    rc = ranking_config(cfg)
    blocked_ids = _expand_near_ids(set(avoid_ids or ()), int(rc["nearShotRadius"]))
    blocked_groups = set(avoid_groups or ())
    pool = _prefer_fresh_pool(pool, blocked_ids=blocked_ids, blocked_groups=blocked_groups)
    pool = _prefer_forward_pool(
        pool,
        cursor=int(story_cursor or 0),
        slack=int(rc["storyCursorSlack"]),
    )
    shot_to_scene = semantic.get("shotToScene") or {}
    group_of = semantic.get("shotToGroup") or {}
    beats = segment.get("visualBeats") or []
    if not beats:
        beats = [{"order": 1, "description": str(segment.get("narration") or "")[:160]}]

    k = max(len(beats), max(1, int(round(audio_dur / 4.0))))
    k = min(k, max(1, len(pool)))

    beat_texts = [str(b.get("description") or "") for b in beats]
    text_embs = encode_texts(beat_texts) if embeddings else None
    ev_mid = event_mid
    if ev_mid is None:
        mids = [_shot_mid(c) for c in pool]
        ev_mid = sum(mids) / max(1, len(mids))

    used: set[int] = set()
    picked: list[dict[str, Any]] = []
    relevance: dict[int, float] = {}
    score_debug: dict[int, dict[str, float]] = {}

    def floor_id() -> int:
        if picked:
            return max(int(p["id"]) for p in picked)
        return int(story_cursor or 0)

    def score_candidate(c: dict[str, Any], beat_i: int, desc: str, last: dict[str, Any] | None) -> float:
        sid = int(c["id"])
        clip_s = 0.0
        if text_embs and beat_i < len(text_embs):
            clip_s = _max_clip(sid, text_embs[beat_i], embeddings, extras)
        clip_s = max(clip_s, 0.5 * score_text_overlap(desc, str(c.get("subtitle") or "")))
        temp = temporal_score(_shot_mid(c), ev_mid, decay_sec=float(rc["temporalDecaySec"]))
        q = quality_score(c.get("quality") if isinstance(c.get("quality"), dict) else None)
        same_scene = 1.0 if last is not None and c.get("sceneGroupId") == last.get("sceneGroupId") else 0.35
        if last is None:
            same_scene = 0.5
        repeat = 0.0
        if last is not None and abs(sid - int(last["id"])) == 1:
            repeat = 0.55
        score = final_score(
            clip_sim=clip_s,
            temporal=temp,
            quality=q,
            scene=same_scene,
            character=0.0,
            repeat_hint=repeat,
            cfg=cfg,
        )
        if last is not None and _shot_mid(c) + 0.5 < _shot_mid(last):
            score *= 0.85
        if sid in blocked_ids:
            score *= 0.18
        elif c.get("sceneGroupId") in blocked_groups:
            score *= 0.5
        floor = floor_id()
        if floor > 0 and sid <= floor:
            score *= 0.12
        score_debug[sid] = {
            "clip": round(clip_s, 3),
            "temporal": round(temp, 3),
            "quality": round(q, 3),
            "scene": round(same_scene, 3),
            "final": round(score, 3),
        }
        return score

    for bi, beat in enumerate(beats):
        desc = str(beat.get("description") or "")
        best: dict[str, Any] | None = None
        best_score = -1.0
        last = picked[-1] if picked else None
        unused = [c for c in pool if int(c["id"]) not in used]
        work = _prefer_forward_pool(unused, cursor=floor_id(), slack=0) or unused
        for c in work:
            sid = int(c["id"])
            score = score_candidate(c, bi, desc, last)
            if score > best_score:
                best_score = score
                best = c
        if best:
            used.add(int(best["id"]))
            relevance[int(best["id"])] = max(relevance.get(int(best["id"]), 0), best_score)
            picked.append(best)

    remaining = [c for c in pool if int(c["id"]) not in used]
    remaining = _prefer_forward_pool(remaining, cursor=floor_id(), slack=int(rc["storyCursorSlack"])) or remaining
    for c in remaining:
        relevance[int(c["id"])] = score_candidate(c, 0, beat_texts[0] if beat_texts else "", picked[-1] if picked else None)

    need_more = max(0, k - len(picked))
    total_dur = sum(float(p.get("durationSec") or 0) for p in picked)
    fill_iters = 0
    max_fill_iters = max(len(pool), len(beats) + 8)
    while total_dur < audio_dur * 0.85 and remaining and len(picked) < max(k + 4, len(beats) + 4):
        fill_iters += 1
        if fill_iters > max_fill_iters:
            LOG.warning(
                "CallB: duration fill stopped after %d iters (audio=%.1fs covered=%.1fs)",
                fill_iters,
                audio_dur,
                total_dur,
            )
            break
        need_more = max(need_more, 1)
        extra = mmr_select(
            remaining,
            relevance=relevance,
            embeddings=embeddings,
            k=1,
            lambda_rel=float(rc["lambdaRel"]),
            shot_to_scene=shot_to_scene,
            scene_cap=int(rc["sceneCap"]),
            selected_seed=picked,
            consecutive_penalty=float(rc["consecutivePenalty"]),
            group_of=group_of,
        )
        if not extra:
            break
        for e in extra:
            sid = int(e["id"])
            if sid in used:
                continue
            used.add(sid)
            picked.append(e)
            total_dur += float(e.get("durationSec") or 0)
            remaining = [c for c in remaining if int(c["id"]) != sid]
        remaining = _prefer_forward_pool(remaining, cursor=floor_id(), slack=int(rc["storyCursorSlack"])) or remaining
        need_more -= 1
        if need_more <= 0 and total_dur >= audio_dur * 0.85:
            break

    if need_more > 0 and remaining:
        extra = mmr_select(
            remaining,
            relevance=relevance,
            embeddings=embeddings,
            k=need_more,
            lambda_rel=float(rc["lambdaRel"]),
            shot_to_scene=shot_to_scene,
            scene_cap=int(rc["sceneCap"]),
            selected_seed=picked,
            consecutive_penalty=float(rc["consecutivePenalty"]),
            group_of=group_of,
        )
        for e in extra:
            sid = int(e["id"])
            if sid in used:
                continue
            used.add(sid)
            picked.append(e)

    ordered = sorted(picked, key=lambda s: (int(s["id"]), float(s.get("startSec") or 0)))
    out_ids: list[int] = []
    acc = 0.0
    for s in ordered:
        out_ids.append(int(s["id"]))
        acc += float(s.get("durationSec") or 0)
        if acc >= audio_dur * 1.25 and len(out_ids) >= max(2, len(beats)):
            break
    if debug_rows is not None:
        ranked_pool = sorted(
            ((int(c["id"]), score_debug.get(int(c["id"]), {})) for c in pool),
            key=lambda x: float((x[1] or {}).get("final") or 0),
            reverse=True,
        )
        debug_rows.append(
            {
                "narration": str(segment.get("narration") or "")[:240],
                "selected": out_ids,
                "topCandidates": [
                    {"shot_id": sid, **(dbg or {}), "scene_group_id": shots_by_id.get(sid, {}).get("sceneGroupId")}
                    for sid, dbg in ranked_pool[:5]
                ],
            }
        )
    return out_ids or [int(pool[0]["id"])]


def plan_all_segments(
    segments: list[dict[str, Any]],
    *,
    segment_candidates: list[list[dict[str, Any]]],
    tts_meta: list[dict[str, Any]],
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    work_dir: Path | None = None,
    cfg: dict[str, Any] | None = None,
    knowledge: dict[str, Any] | None = None,
    movie_windows: list[Any] | None = None,
) -> dict[str, Any]:
    embeddings: dict[int, list[float]] = {}
    extras: dict[int, list[list[float]]] = {}
    if work_dir is not None:
        embeddings, extras = _load_shot_embeddings(shots, work_dir)

    events_by_id = {
        str(e["eventId"]): e
        for e in ((knowledge or {}).get("events") or [])
        if isinstance(e, dict) and e.get("eventId")
    }

    total = len(segments)
    selected: list[list[int]] = []
    details: list[list[dict[str, Any]]] = []
    debug_all: list[dict[str, Any]] = []
    global_used: set[int] = set()
    recent_groups: list[set[Any]] = []
    cooldown = max(0, int(ranking_config(cfg)["sceneCooldownSegments"]))
    rc = ranking_config(cfg)
    opening_n = min(total, max(0, int(rc["openingSegments"])))
    ending_n = min(total, max(0, int(rc["endingSegments"])))
    if opening_n + ending_n > total:
        ending_n = min(ending_n, max(1, total // 3) if total >= 2 else 0)
        opening_n = min(opening_n, max(0, total - ending_n))
    ending_start = total - ending_n if ending_n else total
    lo, hi, _all_ids = _shot_id_bounds(shots)
    end_frac = min(0.35, max(0.04, float(rc["endingShotFrac"])))
    ending_floor = min(hi, max(lo, hi - int((hi - lo + 1) * end_frac) + 1)) if hi > lo else hi
    shots_by_id = {int(s["id"]): s for s in shots}
    story_cursor = 0
    for i, seg in enumerate(segments):
        progress(LOG, "CallB segment", i, total, every=10)
        cands = segment_candidates[i] if i < len(segment_candidates) else []
        audio_dur = _audio_need_sec(tts_meta, i, fallback=float(seg.get("estimatedDuration") or 28.0))
        source_window = _segment_source_window(
            index=i,
            total=total,
            segment=seg,
            events_by_id=events_by_id,
            movie_windows=movie_windows,
            shots=shots,
        )
        event_mid = (source_window[0] + source_window[1]) / 2.0
        avoid_groups: set[Any] = set()
        for prior in recent_groups[-cooldown:]:
            avoid_groups.update(prior)
        dbg: list[dict[str, Any]] = []
        if i < opening_n:
            ids = plan_opening_shots(
                shots,
                audio_dur=audio_dur,
                cursor=story_cursor,
                used=global_used,
                cfg=cfg,
            )
            in_win = [
                sid
                for sid in ids
                if _overlaps_window(
                    shots_by_id.get(sid) or {}, source_window[0], source_window[1], slack=20.0
                )
            ]
            ids = in_win or _cover_audio_shots(
                shots,
                audio_dur=audio_dur,
                used=global_used,
                cursor=story_cursor,
                min_id=lo,
                max_id=ending_floor - 1 if ending_n else hi,
                window=source_window,
                cfg=cfg,
                recent_rows=selected,
            )
            debug_all.append(
                {
                    "segmentIndex": i,
                    "mode": "opening",
                    "narration": str(seg.get("narration") or "")[:240],
                    "selected": ids,
                    "window": list(source_window),
                }
            )
        elif i >= ending_start:
            ids = plan_ending_shots(
                shots,
                audio_dur=audio_dur,
                cursor=story_cursor,
                used=global_used,
                ending_floor=ending_floor,
                cfg=cfg,
            )
            in_win = [
                sid
                for sid in ids
                if _overlaps_window(
                    shots_by_id.get(sid) or {}, source_window[0], source_window[1], slack=20.0
                )
            ]
            ids = in_win or _cover_audio_shots(
                shots,
                audio_dur=audio_dur,
                used=global_used,
                cursor=story_cursor,
                min_id=ending_floor,
                max_id=hi,
                window=source_window,
                cfg=cfg,
                recent_rows=selected,
            )
            debug_all.append(
                {
                    "segmentIndex": i,
                    "mode": "ending",
                    "narration": str(seg.get("narration") or "")[:240],
                    "selected": ids,
                    "window": list(source_window),
                }
            )
        else:
            ids = plan_shots_for_segment(
                seg,
                cands,
                audio_dur=audio_dur,
                shots=shots,
                semantic=semantic,
                embeddings=embeddings or None,
                extras=extras or None,
                cfg=cfg,
                event_mid=event_mid,
                debug_rows=dbg,
                avoid_ids=global_used,
                avoid_groups=avoid_groups,
                story_cursor=story_cursor,
                id_max=ending_floor - 1 if ending_n else None,
                source_window=source_window,
            )
        if not ids:
            if i >= ending_start:
                fill_min, fill_max = ending_floor, hi
            elif i < opening_n:
                fill_min, fill_max = lo, ending_floor - 1 if ending_n else hi
            else:
                fill_min, fill_max = lo, ending_floor - 1 if ending_n else hi
            ids = _cover_audio_shots(
                shots,
                audio_dur=audio_dur,
                used=global_used,
                cursor=story_cursor,
                min_id=max(lo, fill_min),
                max_id=max(fill_min, fill_max),
                window=source_window,
                cfg=cfg,
                recent_rows=selected,
            )
        ids = sorted({int(x) for x in ids})
        if not ids:
            ids = _cover_audio_shots(
                shots,
                audio_dur=audio_dur,
                used=global_used,
                cursor=story_cursor,
                window=source_window,
                cfg=cfg,
                allow_reuse=True,
                recent_rows=selected,
            )
        selected.append(ids)
        global_used.update(ids)
        if ids:
            story_cursor = max(story_cursor, max(ids))
        groups = {shots_by_id.get(sid, {}).get("sceneGroupId") for sid in ids}
        recent_groups.append({g for g in groups if g is not None})
        if dbg:
            debug_all.append({"segmentIndex": i, **dbg[0]})
        row = []
        for sid in ids:
            s = shots_by_id.get(sid) or {}
            row.append(
                {
                    "shot_id": sid,
                    "scene_group_id": s.get("sceneGroupId"),
                    "quality_score": quality_score(s.get("quality") if isinstance(s.get("quality"), dict) else None),
                }
            )
        details.append(row)

    out: dict[str, Any] = {PICKS_SELECTED_SHOTS: selected, "selectedShotsDetail": details}
    if debug_all:
        out["_debugRanking"] = debug_all
    return out


def sanitize_picks(
    raw: list[list[int]] | None,
    *,
    segment_candidates: list[list[dict[str, Any]]],
    tts_meta: list[dict[str, Any]],
    narrations: list[str],
    shots: list[dict[str, Any]] | None = None,
    cfg: dict[str, Any] | None = None,
    movie_windows: list[Any] | None = None,
    segments: list[dict[str, Any]] | None = None,
    knowledge: dict[str, Any] | None = None,
) -> list[list[int]]:
    """Keep planner ids; drop duplicates and timeline regressions. Never emit empty rows."""
    sanitized = raw or []
    n = max(len(narrations), len(sanitized), len(tts_meta))
    fixed: list[list[int]] = []
    used: set[int] = set()
    cursor = 0
    shots = shots or []
    shots_by_id = {int(s["id"]): s for s in shots if isinstance(s, dict) and s.get("id") is not None}
    events_by_id = {
        str(e["eventId"]): e
        for e in ((knowledge or {}).get("events") or [])
        if isinstance(e, dict) and e.get("eventId")
    }

    def window_for(index: int) -> tuple[float, float]:
        seg = segments[index] if segments and index < len(segments) else {}
        return _segment_source_window(
            index=index,
            total=n,
            segment=seg,
            events_by_id=events_by_id,
            movie_windows=movie_windows,
            shots=shots,
        )

    def fill_row(index: int) -> list[int]:
        need = _audio_need_sec(tts_meta, index)
        take = max(1, int(need / 3))
        win = window_for(index)
        cands = segment_candidates[index] if index < len(segment_candidates) else []
        in_win_cands = [
            c
            for c in cands
            if isinstance(c, dict) and _overlaps_window(c, win[0], win[1], slack=8.0)
        ]
        row = _ids_from_candidates(in_win_cands or cands, used=used, cursor=cursor, take=take)
        if row:
            kept = [
                sid
                for sid in row
                if _overlaps_window(shots_by_id.get(sid) or {}, win[0], win[1], slack=20.0)
            ]
            if kept:
                return kept
        return _cover_audio_shots(
            shots,
            audio_dur=need,
            used=used,
            cursor=cursor,
            window=win,
            cfg=cfg,
            allow_reuse=True,
            recent_rows=fixed,
        )

    for i in range(n):
        chosen = sanitized[i] if i < len(sanitized) else []
        seen_row: set[int] = set()
        row: list[int] = []
        win = window_for(i)
        for sid in chosen or []:
            sid = int(sid)
            if sid in seen_row or sid in used or sid <= cursor:
                continue
            shot = shots_by_id.get(sid)
            if shot is not None and not _overlaps_window(shot, win[0], win[1], slack=45.0):
                continue
            seen_row.add(sid)
            row.append(sid)
        row.sort()
        if not row:
            row = fill_row(i)
        used.update(row)
        if row:
            cursor = max(cursor, max(row))
        fixed.append(row)
    return fixed
