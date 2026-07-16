"""Shot diversity helpers for CallB planner."""

from __future__ import annotations

import math
from typing import Any


def _cosine(a: list[float] | None, b: list[float] | None) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-9
    nb = math.sqrt(sum(y * y for y in b)) or 1e-9
    return dot / (na * nb)


def time_penalty(shot_a: dict[str, Any], shot_b: dict[str, Any], *, threshold_sec: float = 8.0) -> float:
    """Return multiplier in (0, 1] — closer in source time → stronger penalty."""
    mid_a = (float(shot_a.get("startSec") or 0) + float(shot_a.get("endSec") or 0)) / 2.0
    mid_b = (float(shot_b.get("startSec") or 0) + float(shot_b.get("endSec") or 0)) / 2.0
    dist = abs(mid_a - mid_b)
    if dist >= threshold_sec:
        return 1.0
    # linear down to 0.35 at distance 0
    return 0.35 + 0.65 * (dist / threshold_sec)


def scene_id_of(shot: dict[str, Any], shot_to_scene: dict[str, str]) -> str | None:
    sid = shot.get("id", shot.get("shot_id"))
    if sid is None:
        return None
    return shot_to_scene.get(str(int(sid)))


def mmr_select(
    candidates: list[dict[str, Any]],
    *,
    relevance: dict[int, float],
    embeddings: dict[int, list[float]] | None,
    k: int,
    lambda_rel: float = 0.7,
    shot_to_scene: dict[str, str] | None = None,
    scene_cap: int = 2,
    selected_seed: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """
    Maximal Marginal Relevance selection with scene cap + time penalty vs selected.
    """
    shot_to_scene = shot_to_scene or {}
    selected: list[dict[str, Any]] = list(selected_seed or [])
    scene_counts: dict[str, int] = {}
    for s in selected:
        sc = scene_id_of(s, shot_to_scene)
        if sc:
            scene_counts[sc] = scene_counts.get(sc, 0) + 1

    pool = {int(c.get("id", c.get("shot_id"))): c for c in candidates if c.get("id") is not None or c.get("shot_id") is not None}
    selected_ids = {int(s.get("id", s.get("shot_id"))) for s in selected}

    while len(selected) < k and pool:
        best_id: int | None = None
        best_score = -1e9
        for sid, cand in pool.items():
            if sid in selected_ids:
                continue
            sc = scene_id_of(cand, shot_to_scene)
            if sc and scene_counts.get(sc, 0) >= scene_cap:
                continue
            rel = float(relevance.get(sid, cand.get("score") or 0.0))
            max_sim = 0.0
            emb_c = (embeddings or {}).get(sid)
            for prev in selected:
                pid = int(prev.get("id", prev.get("shot_id")))
                emb_p = (embeddings or {}).get(pid)
                if emb_c and emb_p:
                    max_sim = max(max_sim, _cosine(emb_c, emb_p))
                else:
                    # fallback: duration/time proximity as crude similarity
                    max_sim = max(max_sim, 1.0 - time_penalty(cand, prev))
            mmr = lambda_rel * rel - (1.0 - lambda_rel) * max_sim
            # apply time penalty vs last selected
            if selected:
                mmr *= time_penalty(cand, selected[-1])
            if mmr > best_score:
                best_score = mmr
                best_id = sid
        if best_id is None:
            # relax scene cap
            for sid, cand in pool.items():
                if sid in selected_ids:
                    continue
                rel = float(relevance.get(sid, cand.get("score") or 0.0))
                if rel > best_score:
                    best_score = rel
                    best_id = sid
        if best_id is None:
            break
        chosen = pool.pop(best_id)
        # normalize id field
        chosen = {**chosen, "id": best_id, "shot_id": best_id}
        selected.append(chosen)
        selected_ids.add(best_id)
        sc = scene_id_of(chosen, shot_to_scene)
        if sc:
            scene_counts[sc] = scene_counts.get(sc, 0) + 1

    return selected


def order_by_story_flow(shots: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Proxy story-flow: prefer chronological source order with mild wide→close
    (longer duration treated as wider establishing).
    """
    if not shots:
        return []
    # primary: startSec ascending; secondary: longer first within ~nearby clusters
    return sorted(
        shots,
        key=lambda s: (
            float(s.get("startSec") or 0.0),
            -float(s.get("durationSec") or 0.0),
        ),
    )


def score_text_overlap(query: str, candidate_text: str) -> float:
    q = set(re_findall(query))
    c = set(re_findall(candidate_text))
    if not q:
        return 0.0
    return len(q & c) / max(1, len(q))


def re_findall(text: str) -> list[str]:
    import re

    return re.findall(r"[a-zA-ZÀ-ỹ0-9]{3,}", (text or "").lower())
