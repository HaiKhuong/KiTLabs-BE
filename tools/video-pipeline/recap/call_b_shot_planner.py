"""CallB — Shot Planner: match visualBeats → ordered shot ids covering audioDur."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from diversity import mmr_select, order_by_story_flow, score_text_overlap
from gemini_recap import PICKS_SELECTED_SHOTS

LOG = logging.getLogger("recap.call_b")


def _shot_mid(s: dict[str, Any]) -> float:
    return (float(s.get("startSec") or 0) + float(s.get("endSec") or 0)) / 2.0


def _load_shot_embeddings(
    shots: list[dict[str, Any]],
    work_dir: Path,
) -> dict[int, list[float]]:
    """Load/compute OpenCLIP image embeddings for keyframes when available."""
    keyframes_dir = work_dir / "keyframes"
    if not keyframes_dir.exists():
        return {}
    paths: list[tuple[int, Path]] = []
    for s in shots:
        sid = int(s["id"])
        p = keyframes_dir / f"shot_{sid:05d}.jpg"
        if p.exists():
            paths.append((sid, p))
    if not paths:
        return {}
    try:
        import open_clip  # type: ignore
        import torch
        from PIL import Image

        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai"
        )
        model.eval()
        out: dict[int, list[float]] = {}
        with torch.no_grad():
            for sid, p in paths:
                img = preprocess(Image.open(p).convert("RGB")).unsqueeze(0)
                feat = model.encode_image(img)
                feat = feat / feat.norm(dim=-1, keepdim=True)
                out[sid] = feat.squeeze(0).cpu().tolist()
        return out
    except Exception as exc:
        LOG.warning("CallB: shot embeddings unavailable (%s)", exc)
        return {}


def _encode_texts(texts: list[str]) -> list[list[float]] | None:
    if not texts:
        return []
    try:
        import open_clip  # type: ignore
        import torch

        model, _, _ = open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai")
        tokenizer = open_clip.get_tokenizer("ViT-B-32")
        model.eval()
        with torch.no_grad():
            tokens = tokenizer(texts)
            feat = model.encode_text(tokens)
            feat = feat / feat.norm(dim=-1, keepdim=True)
            return [row.cpu().tolist() for row in feat]
    except Exception as exc:
        LOG.warning("CallB: text embeddings unavailable (%s)", exc)
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    import math

    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-9
    nb = math.sqrt(sum(y * y for y in b)) or 1e-9
    return dot / (na * nb)


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
                "semanticSceneId": base.get("semanticSceneId"),
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
) -> list[int]:
    """Match visualBeats → diverse ordered shot ids covering ~audio_dur."""
    shots_by_id = {int(s["id"]): s for s in shots}
    pool = _enrich_candidates(candidates, shots_by_id)
    if not pool:
        # fallback: any shots near movie window if present on segment via event windows not available here
        return []

    shot_to_scene = semantic.get("shotToScene") or {}
    beats = segment.get("visualBeats") or []
    if not beats:
        beats = [{"order": 1, "description": str(segment.get("narration") or "")[:160]}]

    k = max(len(beats), max(1, int(round(audio_dur / 4.0))))
    k = min(k, max(1, len(pool)))

    beat_texts = [str(b.get("description") or "") for b in beats]
    text_embs = _encode_texts(beat_texts) if embeddings else None

    # Per-beat best candidate (greedy, then diversity refine)
    used: set[int] = set()
    picked: list[dict[str, Any]] = []
    relevance: dict[int, float] = {int(c["id"]): float(c.get("score") or 0) for c in pool}

    for bi, beat in enumerate(beats):
        desc = str(beat.get("description") or "")
        best: dict[str, Any] | None = None
        best_score = -1.0
        for c in pool:
            sid = int(c["id"])
            if sid in used:
                continue
            score = float(c.get("score") or 0)
            score += 0.5 * score_text_overlap(desc, str(c.get("subtitle") or ""))
            if text_embs and embeddings and sid in embeddings:
                score += 0.8 * _cosine(text_embs[bi], embeddings[sid])
            # prefer chronological progression
            if picked:
                if _shot_mid(c) + 0.5 < _shot_mid(picked[-1]):
                    score *= 0.75
            if score > best_score:
                best_score = score
                best = c
        if best:
            used.add(int(best["id"]))
            relevance[int(best["id"])] = max(relevance.get(int(best["id"]), 0), best_score)
            picked.append(best)

    # Fill to cover duration / k with MMR
    remaining = [c for c in pool if int(c["id"]) not in used]
    need_more = max(0, k - len(picked))
    # also ensure total duration ≈ audio_dur
    total_dur = sum(float(p.get("durationSec") or 0) for p in picked)
    while total_dur < audio_dur * 0.85 and remaining and len(picked) < max(k + 4, len(beats) + 4):
        need_more = max(need_more, 1)
        extra = mmr_select(
            remaining,
            relevance=relevance,
            embeddings=embeddings,
            k=1,
            shot_to_scene=shot_to_scene,
            scene_cap=2,
            selected_seed=picked,
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
            shot_to_scene=shot_to_scene,
            scene_cap=2,
            selected_seed=picked,
        )
        for e in extra:
            sid = int(e["id"])
            if sid in used:
                continue
            used.add(sid)
            picked.append(e)

    ordered = order_by_story_flow(picked)
    # Soft trim if far over audio_dur
    out_ids: list[int] = []
    acc = 0.0
    for s in ordered:
        out_ids.append(int(s["id"]))
        acc += float(s.get("durationSec") or 0)
        if acc >= audio_dur * 1.25 and len(out_ids) >= max(2, len(beats)):
            break
    return out_ids or [int(pool[0]["id"])]


def plan_all_segments(
    segments: list[dict[str, Any]],
    *,
    segment_candidates: list[list[dict[str, Any]]],
    tts_meta: list[dict[str, Any]],
    shots: list[dict[str, Any]],
    semantic: dict[str, Any],
    work_dir: Path | None = None,
) -> dict[str, Any]:
    embeddings: dict[int, list[float]] = {}
    if work_dir is not None:
        embeddings = _load_shot_embeddings(shots, work_dir)

    selected: list[list[int]] = []
    for i, seg in enumerate(segments):
        cands = segment_candidates[i] if i < len(segment_candidates) else []
        audio_dur = float((tts_meta[i] if i < len(tts_meta) else {}).get("durationSec") or seg.get("estimatedDuration") or 28.0)
        ids = plan_shots_for_segment(
            seg,
            cands,
            audio_dur=audio_dur,
            shots=shots,
            semantic=semantic,
            embeddings=embeddings or None,
        )
        if not ids and cands:
            ids = [int(c.get("id", c.get("shot_id"))) for c in cands[: max(1, int(audio_dur / 3))]]
        selected.append(ids)

    return {PICKS_SELECTED_SHOTS: selected}
