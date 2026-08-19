"""Shared OpenCLIP ViT-B-32 helpers — load once, reuse across cluster + CallB."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401  — HF cache trước open_clip/torch

from progress_log import progress

LOG = logging.getLogger("recap.clip")

CLIP_MODEL = "ViT-B-32"
CLIP_PRETRAINED = "openai"
EMBEDDINGS_FILENAME = "shot_embeddings.json"

_CLIP: tuple[Any, Any, Any] | None = None


def get_clip() -> tuple[Any, Any, Any]:
    """Return (model, preprocess, tokenizer), loading ViT-B-32 once per process."""
    global _CLIP
    if _CLIP is not None:
        return _CLIP
    import open_clip  # type: ignore

    LOG.info("OpenCLIP: loading %s", CLIP_MODEL)
    model, _, preprocess = open_clip.create_model_and_transforms(
        CLIP_MODEL, pretrained=CLIP_PRETRAINED
    )
    tokenizer = open_clip.get_tokenizer(CLIP_MODEL)
    model.eval()
    _CLIP = (model, preprocess, tokenizer)
    return _CLIP


def encode_image_paths(paths: list[Path], *, batch_size: int = 32) -> list[list[float]]:
    """Encode keyframe JPG paths in order; empty list when paths is empty."""
    if not paths:
        return []
    import torch
    from PIL import Image

    model, preprocess, _ = get_clip()
    out: list[list[float]] = []
    total = len(paths)
    LOG.info("OpenCLIP: encoding %d keyframes", total)
    with torch.no_grad():
        for start in range(0, total, batch_size):
            chunk = paths[start : start + batch_size]
            imgs = torch.cat(
                [preprocess(Image.open(p).convert("RGB")).unsqueeze(0) for p in chunk],
                dim=0,
            )
            feat = model.encode_image(imgs)
            feat = feat / feat.norm(dim=-1, keepdim=True)
            out.extend(row.cpu().tolist() for row in feat)
            done = min(start + batch_size, total)
            batch_idx = start // batch_size
            batch_total = (total + batch_size - 1) // batch_size
            progress(LOG, "OpenCLIP keyframes", batch_idx, batch_total, every=max(1, batch_total // 4))
    return out


def encode_shot_keyframes(
    items: list[tuple[int, Path]],
    *,
    batch_size: int = 32,
) -> dict[int, list[float]]:
    """Encode (shot_id, path) pairs → {shot_id: embedding}."""
    if not items:
        return {}
    ids = [sid for sid, _ in items]
    paths = [p for _, p in items]
    vectors = encode_image_paths(paths, batch_size=batch_size)
    return {sid: vec for sid, vec in zip(ids, vectors)}


def encode_texts(texts: list[str]) -> list[list[float]] | None:
    if not texts:
        return []
    try:
        import torch

        model, _, tokenizer = get_clip()
        with torch.no_grad():
            tokens = tokenizer(texts)
            feat = model.encode_text(tokens)
            feat = feat / feat.norm(dim=-1, keepdim=True)
            return [row.cpu().tolist() for row in feat]
    except Exception as exc:
        LOG.warning("OpenCLIP text encode failed (%s)", exc)
        return None


def _embeddings_path(work_dir: Path) -> Path:
    return work_dir / EMBEDDINGS_FILENAME


def keyframes_cache_fresh(emb_path: Path, keyframes_dir: Path) -> bool:
    """True when embedding file exists and no keyframe JPG is newer."""
    if not emb_path.is_file():
        return False
    art_mtime = emb_path.stat().st_mtime
    if keyframes_dir.is_dir():
        for p in keyframes_dir.glob("shot_*.jpg"):
            if p.is_file() and p.stat().st_mtime > art_mtime:
                return False
    return True


def save_shot_embeddings(work_dir: Path, embeddings: dict[int, list[float]]) -> Path:
    path = _embeddings_path(work_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model": CLIP_MODEL,
        "pretrained": CLIP_PRETRAINED,
        "embeddings": {str(sid): vec for sid, vec in sorted(embeddings.items())},
    }
    path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return path


def load_shot_embeddings(
    work_dir: Path,
    *,
    keyframes_dir: Path | None = None,
) -> dict[int, list[float]]:
    """Load cached embeddings when fresh; otherwise return {}."""
    path = _embeddings_path(work_dir)
    kf_dir = keyframes_dir or (work_dir / "keyframes")
    if not keyframes_cache_fresh(path, kf_dir):
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if raw.get("model") != CLIP_MODEL or raw.get("pretrained") != CLIP_PRETRAINED:
        return {}
    emb_raw = raw.get("embeddings") or {}
    if not isinstance(emb_raw, dict):
        return {}
    out: dict[int, list[float]] = {}
    for key, vec in emb_raw.items():
        if isinstance(vec, list) and vec:
            out[int(key)] = vec
    return out
