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
from diversity import cosine, mmr_select, order_by_story_flow, score_text_overlap
from gemini_recap import PICKS_SELECTED_SHOTS
from progress_log import progress
from ranking import final_score, quality_score, ranking_config, shot_mid, temporal_score

LOG = logging.getLogger("recap.call_b")


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
) -> list[int]:
    """Match visualBeats → diverse ordered shot ids covering ~audio_dur."""
    shots_by_id = {int(s["id"]): s for s in shots}
    pool = _enrich_candidates(candidates, shots_by_id)
    if not pool:
        return []

    rc = ranking_config(cfg)
    blocked_ids = _expand_near_ids(set(avoid_ids or ()), int(rc["nearShotRadius"]))
    blocked_groups = set(avoid_groups or ())
    pool = _prefer_fresh_pool(pool, blocked_ids=blocked_ids, blocked_groups=blocked_groups)
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
        for c in pool:
            sid = int(c["id"])
            if sid in used:
                continue
            score = score_candidate(c, bi, desc, last)
            if score > best_score:
                best_score = score
                best = c
        if best:
            used.add(int(best["id"]))
            relevance[int(best["id"])] = max(relevance.get(int(best["id"]), 0), best_score)
            picked.append(best)

    remaining = [c for c in pool if int(c["id"]) not in used]
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

    ordered = order_by_story_flow(picked)
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
    shots_by_id = {int(s["id"]): s for s in shots}
    for i, seg in enumerate(segments):
        progress(LOG, "CallB segment", i, total, every=10)
        cands = segment_candidates[i] if i < len(segment_candidates) else []
        audio_dur = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or seg.get("estimatedDuration") or 28.0)
        eids = [str(x) for x in (seg.get("eventIds") or [])]
        mids = []
        for eid in eids:
            ev = events_by_id.get(eid)
            if not ev:
                continue
            win = ev.get("window") or {}
            mids.append((float(win.get("from") or 0) + float(win.get("to") or 0)) / 2.0)
        event_mid = sum(mids) / len(mids) if mids else None
        avoid_groups: set[Any] = set()
        for prior in recent_groups[-cooldown:]:
            avoid_groups.update(prior)
        dbg: list[dict[str, Any]] = []
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
        )
        if not ids and cands:
            ids = [
                int(c.get("id", c.get("shot_id")))
                for c in cands
                if int(c.get("id", c.get("shot_id") or -1)) not in global_used
            ][: max(1, int(audio_dur / 3))]
            if not ids:
                ids = [int(c.get("id", c.get("shot_id"))) for c in cands[: max(1, int(audio_dur / 3))]]
        selected.append(ids)
        global_used.update(ids)
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
) -> list[list[int]]:
    """Keep only shortlisted shot ids; fill gaps from candidate pool without repeating used shots."""
    sanitized = raw or []
    fixed: list[list[int]] = []
    used: set[int] = set()
    for i, chosen in enumerate(sanitized):
        allow = {int(c["id"]) for c in segment_candidates[i]} if i < len(segment_candidates) else set()
        row = [int(x) for x in (chosen or []) if int(x) in allow] if allow else [int(x) for x in (chosen or [])]
        seen_row: set[int] = set()
        unique_row: list[int] = []
        for sid in row:
            if sid in seen_row:
                continue
            seen_row.add(sid)
            unique_row.append(sid)
        row = unique_row
        if not row and i < len(segment_candidates) and segment_candidates[i]:
            need = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or 28)
            take = max(1, int(need / 3))
            row = [int(c["id"]) for c in segment_candidates[i] if int(c["id"]) not in used][:take]
            if not row:
                row = [int(c["id"]) for c in segment_candidates[i][:take]]
        used.update(row)
        fixed.append(row)
    while len(fixed) < len(narrations):
        i = len(fixed)
        if i < len(segment_candidates) and segment_candidates[i]:
            need = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or 28)
            take = max(1, int(need / 3))
            row = [int(c["id"]) for c in segment_candidates[i] if int(c["id"]) not in used][:take]
            if not row:
                row = [int(c["id"]) for c in segment_candidates[i][:take]]
            used.update(row)
            fixed.append(row)
        else:
            fixed.append([])
    return fixed
