from __future__ import annotations

import logging
import subprocess
from pathlib import Path
from typing import Any

LOG = logging.getLogger("recap.cluster")


def cluster_semantic_scenes(
    video: Path,
    shots: list[dict[str, Any]],
    work_dir: Path,
    sim_threshold: float = 0.82,
) -> dict[str, Any]:
    """Adjacent CLIP merge; fallback: merge by short gaps only."""
    keyframes_dir = work_dir / "keyframes"
    keyframes_dir.mkdir(parents=True, exist_ok=True)
    paths = _extract_mid_keyframes(video, shots, keyframes_dir)

    embeddings = _embed_keyframes(paths)
    scenes: list[dict[str, Any]] = []
    if not shots:
        return {"scenes": [], "shotToScene": {}}

    current_ids = [int(shots[0]["id"])]
    current_emb = embeddings[0] if embeddings else None

    def flush(ids: list[int]) -> None:
        members = [s for s in shots if int(s["id"]) in ids]
        if not members:
            return
        start = min(float(m["startSec"]) for m in members)
        end = max(float(m["endSec"]) for m in members)
        hero = max(members, key=lambda m: float(m["endSec"]) - float(m["startSec"]))
        scenes.append(
            {
                "semanticSceneId": f"ss_{len(scenes):04d}",
                "shotIds": ids,
                "startSec": start,
                "endSec": end,
                "durationSec": end - start,
                "heroShotId": int(hero["id"]),
            }
        )

    for i in range(1, len(shots)):
        sid = int(shots[i]["id"])
        emb = embeddings[i] if embeddings and i < len(embeddings) else None
        merge = False
        if current_emb is not None and emb is not None:
            merge = _cosine(current_emb, emb) >= sim_threshold
        else:
            # fallback: merge if previous shot very short
            prev = shots[i - 1]
            merge = (float(prev["endSec"]) - float(prev["startSec"])) < 2.0

        if merge:
            current_ids.append(sid)
            if emb is not None:
                current_emb = emb
        else:
            flush(current_ids)
            current_ids = [sid]
            current_emb = emb

    flush(current_ids)
    shot_to_scene = {}
    for sc in scenes:
        for sid in sc["shotIds"]:
            shot_to_scene[str(sid)] = sc["semanticSceneId"]
    return {"scenes": scenes, "shotToScene": shot_to_scene}


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
) -> list[dict[str, Any]]:
    """Return rich candidate objects sorted by relevance (score desc)."""
    exclude = exclude or set()
    a, b = movie_range
    a = max(0.0, a - pad)
    b = b + pad
    scored: list[tuple[float, dict[str, Any]]] = []
    scene_of = semantic.get("shotToScene") or {}
    seen_scenes: set[str] = set()

    for s in shots:
        sid = int(s["id"])
        if sid in exclude:
            continue
        ss, ee = float(s["startSec"]), float(s["endSec"])
        if ee < a or ss > b:
            continue
        overlap = max(0.0, min(ee, b) - max(ss, a))
        dur = max(0.1, ee - ss)
        duration_fit = 1.0 - min(abs(dur - 6.0) / 10.0, 1.0)
        sc_id = scene_of.get(str(sid))
        diversity = 0.0 if (sc_id and sc_id in seen_scenes) else 0.15
        score = 0.55 * (overlap / max(b - a, 1.0)) + 0.30 * duration_fit + diversity
        scored.append(
            (
                score,
                {
                    "id": sid,
                    "startSec": round(ss, 2),
                    "endSec": round(ee, 2),
                    "durationSec": round(dur, 2),
                    "subtitle": _subtitle_for_shot(ss, ee, transcript_segments),
                    "score": round(score, 3),
                },
            )
        )
        if sc_id:
            seen_scenes.add(sc_id)

    scored.sort(key=lambda x: x[0], reverse=True)
    picked = [item for _, item in scored[:limit]]

    if picked:
        total = sum(float(c["durationSec"]) for c in picked)
        if total < need_sec * 1.5:
            picked_ids = {c["id"] for c in picked}
            for _, item in scored[limit:]:
                if item["id"] in picked_ids:
                    continue
                picked.append(item)
                picked_ids.add(item["id"])
                if len(picked) >= limit:
                    break
    return picked


def _extract_mid_keyframes(video: Path, shots: list[dict[str, Any]], out_dir: Path) -> list[Path]:
    paths: list[Path] = []
    for s in shots:
        mid = (float(s["startSec"]) + float(s["endSec"])) / 2.0
        out = out_dir / f"shot_{int(s['id']):05d}.jpg"
        if not out.exists():
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                f"{mid:.3f}",
                "-i",
                str(video),
                "-frames:v",
                "1",
                "-q:v",
                "4",
                str(out),
            ]
            try:
                subprocess.check_call(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except Exception:
                # placeholder empty file skipped
                continue
        paths.append(out)
    # Align length with shots (use last available if some failed)
    while len(paths) < len(shots) and paths:
        paths.append(paths[-1])
    return paths


def _embed_keyframes(paths: list[Path]) -> list[list[float]] | None:
    if not paths:
        return None
    try:
        import open_clip  # type: ignore
        import torch
        from PIL import Image

        model, _, preprocess = open_clip.create_model_and_transforms(
            "ViT-B-32", pretrained="openai"
        )
        model.eval()
        embs: list[list[float]] = []
        with torch.no_grad():
            for p in paths:
                img = preprocess(Image.open(p).convert("RGB")).unsqueeze(0)
                feat = model.encode_image(img)
                feat = feat / feat.norm(dim=-1, keepdim=True)
                embs.append(feat.squeeze(0).cpu().tolist())
        return embs
    except Exception as exc:
        LOG.warning("OpenCLIP unavailable (%s); skip embeddings", exc)
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    import math

    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)) or 1e-9
    nb = math.sqrt(sum(y * y for y in b)) or 1e-9
    return dot / (na * nb)
