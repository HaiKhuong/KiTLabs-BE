from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401  — HF cache → ~/.cache/huggingface/hub (trước open_clip/torch)

from clip_embeddings import encode_image_paths, encode_texts, save_shot_embeddings
from diversity import cosine
from keyframes import VISUAL_VERSION, extract_adaptive_keyframes, list_keyframe_paths_for_shot
from ranking import ranking_config

LOG = logging.getLogger("recap.cluster")


def adjacent_should_merge(
    *,
    clip_sim: float | None,
    sim_threshold: float,
    time_gap: float,
    max_gap: float = 2.5,
    subtitle_jaccard: float = 0.0,
    sub_j_min: float = 0.12,
    prev_duration_sec: float = 99.0,
    next_duration_sec: float = 99.0,
) -> bool:
    """Adjacent-only merge: CLIP + small time gap + subtitle continuity or a short shot."""
    if time_gap > max_gap:
        return False
    short_ok = prev_duration_sec < 2.0 or next_duration_sec < 2.0
    sub_ok = subtitle_jaccard >= sub_j_min
    if clip_sim is None:
        return short_ok
    return clip_sim >= sim_threshold and (sub_ok or short_ok)


def cluster_semantic_scenes(
    video: Path,
    shots: list[dict[str, Any]],
    work_dir: Path,
    sim_threshold: float = 0.82,
    *,
    transcript_segments: list[dict[str, Any]] | None = None,
    cfg: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Adjacent CLIP merge with time gap + subtitle continuity."""
    keyframes_dir = work_dir / "keyframes"
    keyframes_dir.mkdir(parents=True, exist_ok=True)
    rc = ranking_config(cfg)
    extract_adaptive_keyframes(
        video,
        shots,
        keyframes_dir,
        min_shot_sec_for_secondary=float(rc.get("minShotSecForSecondary") or 3.5),
        motion_threshold=float(rc.get("motionThreshold") or 0.22),
        max_secondary=int(rc.get("maxSecondaryPerShot") or 1),
    )
    primary_ids: list[int] = []
    primary_paths: list[Path] = []
    for s in shots:
        sid = int(s["id"])
        p = keyframes_dir / f"shot_{sid:05d}.jpg"
        if p.is_file():
            primary_ids.append(sid)
            primary_paths.append(p)
    encoded = _embed_keyframes(primary_paths)
    emb_by_id: dict[int, list[float]] = {}
    if encoded:
        for sid, vec in zip(primary_ids, encoded):
            emb_by_id[sid] = vec
        save_shot_embeddings(work_dir, emb_by_id)
    embeddings: list[list[float] | None] = [emb_by_id.get(int(s["id"])) for s in shots]

    extra_items: list[tuple[int, Path]] = []
    for s in shots:
        for p in list_keyframe_paths_for_shot(s, keyframes_dir)[1:]:
            extra_items.append((int(s["id"]), p))
    if extra_items:
        try:
            extra_vecs = encode_image_paths([p for _, p in extra_items])
            extras: dict[int, list[list[float]]] = {}
            for (sid, _), vec in zip(extra_items, extra_vecs):
                extras.setdefault(sid, []).append(vec)
            if extras and emb_by_id:
                save_shot_embeddings(work_dir, emb_by_id, extras=extras)
        except Exception as exc:
            LOG.warning("secondary CLIP encode skipped (%s)", exc)

    scenes: list[dict[str, Any]] = []
    if not shots:
        return {"scenes": [], "shotToScene": {}, "visualVersion": VISUAL_VERSION}

    current_ids = [int(shots[0]["id"])]
    current_emb = embeddings[0] if embeddings else None
    current_sub = _subtitle_for_shot(
        float(shots[0]["startSec"]),
        float(shots[0]["endSec"]),
        transcript_segments,
        max_len=240,
    )

    def flush(ids: list[int]) -> None:
        members = [s for s in shots if int(s["id"]) in ids]
        if not members:
            return
        start = min(float(m["startSec"]) for m in members)
        end = max(float(m["endSec"]) for m in members)
        hero = max(members, key=lambda m: float(m["endSec"]) - float(m["startSec"]))
        gid = len(scenes)
        scenes.append(
            {
                "semanticSceneId": f"ss_{gid:04d}",
                "sceneGroupId": gid,
                "shotIds": ids,
                "startSec": start,
                "endSec": end,
                "durationSec": end - start,
                "heroShotId": int(hero["id"]),
            }
        )

    max_gap = 2.5
    sub_j_min = 0.12
    for i in range(1, len(shots)):
        sid = int(shots[i]["id"])
        emb = embeddings[i] if embeddings and i < len(embeddings) else None
        prev = shots[i - 1]
        gap = float(shots[i]["startSec"]) - float(prev["endSec"])
        prev_dur = float(prev["endSec"]) - float(prev["startSec"])
        sub = _subtitle_for_shot(
            float(shots[i]["startSec"]),
            float(shots[i]["endSec"]),
            transcript_segments,
            max_len=240,
        )
        clip_sim = None
        if current_emb is not None and emb is not None:
            clip_sim = cosine(current_emb, emb)
        next_dur = float(shots[i]["endSec"]) - float(shots[i]["startSec"])
        merge = adjacent_should_merge(
            clip_sim=clip_sim,
            sim_threshold=sim_threshold,
            time_gap=gap,
            max_gap=max_gap,
            subtitle_jaccard=_subtitle_jaccard(current_sub, sub),
            sub_j_min=sub_j_min,
            prev_duration_sec=prev_dur,
            next_duration_sec=next_dur,
        )

        if merge:
            current_ids.append(sid)
            if emb is not None:
                current_emb = emb
            if sub:
                current_sub = sub
        else:
            flush(current_ids)
            current_ids = [sid]
            current_emb = emb
            current_sub = sub

    flush(current_ids)
    shot_to_scene = {}
    shot_to_group: dict[str, int] = {}
    for sc in scenes:
        gid = int(sc["sceneGroupId"])
        for sid in sc["shotIds"]:
            shot_to_scene[str(sid)] = sc["semanticSceneId"]
            shot_to_group[str(sid)] = gid
            for s in shots:
                if int(s["id"]) == int(sid):
                    s["semanticSceneId"] = sc["semanticSceneId"]
                    s["sceneGroupId"] = gid
                    break
    return {
        "scenes": scenes,
        "shotToScene": shot_to_scene,
        "shotToGroup": shot_to_group,
        "visualVersion": VISUAL_VERSION,
    }


def _subtitle_jaccard(a: str, b: str) -> float:
    ta = set(_tokens(a))
    tb = set(_tokens(b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(1, len(ta | tb))


def _tokens(text: str) -> list[str]:
    import re

    return re.findall(r"[a-zA-ZÀ-ỹ0-9]{3,}", (text or "").lower())


def _subtitle_for_shot(
    start_sec: float,
    end_sec: float,
    transcript_segments: list[dict[str, Any]] | None,
    max_len: int = 120,
) -> str:
    if not transcript_segments:
        return ""
    parts: list[str] = []
    for seg in transcript_segments:
        ts = float(seg.get("startSec") or 0)
        te = float(seg.get("endSec") or ts)
        if te < start_sec or ts > end_sec:
            continue
        text = str(seg.get("text") or "").strip()
        if text:
            parts.append(text)
    joined = " ".join(parts).strip()
    if len(joined) > max_len:
        return joined[: max_len - 3] + "..."
    return joined


def shortlist_shots(
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    movie_range: tuple[float, float],
    need_sec: float,
    limit: int = 24,
    exclude: set[int] | None = None,
    pad: float = 15.0,
    transcript_segments: list[dict[str, Any]] | None = None,
    *,
    query_text: str = "",
    embeddings: dict[int, list[float]] | None = None,
    neighbor_k: int = 4,
    expand_pad: float = 45.0,
) -> list[dict[str, Any]]:
    """Primary window+SRT union secondary neighbors / scene_group / CLIP."""
    exclude = exclude or set()
    a, b = movie_range
    a0 = max(0.0, a - pad)
    b0 = b + pad
    scene_of = semantic.get("shotToScene") or {}
    group_of = semantic.get("shotToGroup") or {}
    shots_by_id = {int(s["id"]): s for s in shots}
    id_order = [int(s["id"]) for s in shots]
    index_of = {sid: i for i, sid in enumerate(id_order)}

    def pack(s: dict[str, Any], score: float, source: str) -> dict[str, Any]:
        ss, ee = float(s["startSec"]), float(s["endSec"])
        dur = max(0.1, ee - ss)
        return {
            "id": int(s["id"]),
            "startSec": round(ss, 2),
            "endSec": round(ee, 2),
            "durationSec": round(dur, 2),
            "subtitle": _subtitle_for_shot(ss, ee, transcript_segments),
            "score": round(score, 3),
            "source": source,
            "sceneGroupId": s.get("sceneGroupId", group_of.get(str(int(s["id"])))),
        }

    primary: dict[int, dict[str, Any]] = {}
    seen_scenes: set[str] = set()
    for s in shots:
        sid = int(s["id"])
        if sid in exclude:
            continue
        ss, ee = float(s["startSec"]), float(s["endSec"])
        if ee < a0 or ss > b0:
            continue
        overlap = max(0.0, min(ee, b0) - max(ss, a0))
        dur = max(0.1, ee - ss)
        duration_fit = 1.0 - min(abs(dur - 6.0) / 10.0, 1.0)
        sc_id = scene_of.get(str(sid))
        diversity = 0.0 if (sc_id and sc_id in seen_scenes) else 0.15
        score = 0.55 * (overlap / max(b0 - a0, 1.0)) + 0.30 * duration_fit + diversity
        primary[sid] = pack(s, score, "primary")
        if sc_id:
            seen_scenes.add(sc_id)

    # Secondary: neighbors, same group, CLIP vs query
    secondary: dict[int, dict[str, Any]] = {}
    primary_ids = list(primary.keys())
    groups = {group_of.get(str(sid)) for sid in primary_ids if group_of.get(str(sid)) is not None}
    neighbor_ids: set[int] = set()
    for sid in primary_ids:
        idx = index_of.get(sid)
        if idx is None:
            continue
        for j in range(max(0, idx - neighbor_k), min(len(id_order), idx + neighbor_k + 1)):
            nid = id_order[j]
            if nid not in exclude:
                neighbor_ids.add(nid)

    a1, b1 = max(0.0, a - expand_pad), b + expand_pad
    q_emb = None
    if query_text and embeddings:
        texts = encode_texts([query_text])
        if texts:
            q_emb = texts[0]

    for s in shots:
        sid = int(s["id"])
        if sid in exclude or sid in primary:
            continue
        ss, ee = float(s["startSec"]), float(s["endSec"])
        in_wide = not (ee < a1 or ss > b1)
        same_group = group_of.get(str(sid)) in groups and groups
        is_neighbor = sid in neighbor_ids
        clip_hit = 0.0
        if q_emb is not None and embeddings and sid in embeddings:
            clip_hit = cosine(q_emb, embeddings[sid])
        if not (in_wide and (same_group or is_neighbor or clip_hit >= 0.28)):
            continue
        score = 0.25 * max(0.0, clip_hit) + (0.15 if same_group else 0) + (0.1 if is_neighbor else 0)
        secondary[sid] = pack(s, score, "secondary")

    merged = {**secondary, **primary}
    ranked = sorted(merged.values(), key=lambda x: float(x["score"]), reverse=True)
    picked = ranked[:limit]
    if picked:
        total = sum(float(c["durationSec"]) for c in picked)
        if total < need_sec * 1.5:
            picked_ids = {c["id"] for c in picked}
            for item in ranked[limit:]:
                if item["id"] in picked_ids:
                    continue
                picked.append(item)
                picked_ids.add(item["id"])
                if len(picked) >= limit:
                    break
    return picked


def _embed_keyframes(paths: list[Path]) -> list[list[float]] | None:
    if not paths:
        return None
    try:
        return encode_image_paths(paths)
    except Exception as exc:
        LOG.warning("OpenCLIP unavailable (%s); skip embeddings", exc)
        return None
