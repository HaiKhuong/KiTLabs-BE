"""Qwen2.5-VL-3B on shortlisted candidate keyframes only (before CallA-2)."""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

import recap_cache  # noqa: F401 — HF cache before transformers/torch

from keyframes import list_keyframe_paths_for_shot, primary_keyframe_name
from progress_log import progress

LOG = logging.getLogger("recap.vlm")

DEFAULT_MODEL = "Qwen/Qwen2.5-VL-3B-Instruct"
DEFAULT_MAX_SHOTS = 6
DEFAULT_MAX_SIDE = 448

_MODEL: Any = None
_PROCESSOR: Any = None
_MODEL_NAME = ""


def vlm_config(cfg: dict[str, Any] | None) -> dict[str, Any]:
    raw = cfg or {}
    enabled = raw.get("vlmEnabled")
    if enabled is None:
        env = (os.environ.get("RECAP_VLM_ENABLED") or "true").strip().lower()
        enabled = env not in ("0", "false", "no", "off")
    model = str(raw.get("vlmModel") or os.environ.get("RECAP_VLM_MODEL") or DEFAULT_MODEL).strip()
    try:
        max_shots = int(raw.get("vlmMaxShotsPerEvent") or os.environ.get("RECAP_VLM_MAX_SHOTS") or DEFAULT_MAX_SHOTS)
    except (TypeError, ValueError):
        max_shots = DEFAULT_MAX_SHOTS
    return {
        "enabled": bool(enabled),
        "model": model or DEFAULT_MODEL,
        "maxShotsPerEvent": max(2, min(8, max_shots)),
        "maxNewTokens": int(raw.get("vlmMaxNewTokens") or os.environ.get("RECAP_VLM_MAX_NEW_TOKENS") or 128),
        "maxSide": int(raw.get("vlmMaxSide") or os.environ.get("RECAP_VLM_MAX_SIDE") or DEFAULT_MAX_SIDE),
    }


def knowledge_has_vlm(knowledge: dict[str, Any]) -> bool:
    events = knowledge.get("events") or []
    if not events:
        return False
    tagged = [e for e in events if isinstance(e, dict) and str(e.get("visualEvidence") or "").strip()]
    return len(tagged) >= max(1, int(len(events) * 0.5))


def collect_vlm_targets(
    knowledge: dict[str, Any],
    *,
    shots: list[dict[str, Any]],
    keyframes_dir: Path,
    max_shots_per_event: int = DEFAULT_MAX_SHOTS,
) -> list[dict[str, Any]]:
    """One job per event: top-N candidate JPGs that exist on disk."""
    shots_by_id = {int(s["id"]): s for s in shots if isinstance(s, dict) and s.get("id") is not None}
    jobs: list[dict[str, Any]] = []
    for ev in knowledge.get("events") or []:
        if not isinstance(ev, dict):
            continue
        eid = str(ev.get("eventId") or "")
        cands = [c for c in (ev.get("candidate_shots") or []) if isinstance(c, dict)]
        cands = sorted(cands, key=lambda c: float(c.get("score") or 0), reverse=True)
        frames: list[dict[str, Any]] = []
        seen: set[int] = set()
        for c in cands:
            if len(frames) >= max_shots_per_event:
                break
            sid = int(c.get("shot_id") or c.get("id") or -1)
            if sid < 0 or sid in seen:
                continue
            shot = shots_by_id.get(sid) or {"id": sid, "keyframes": {"primary": primary_keyframe_name(sid)}}
            paths = list_keyframe_paths_for_shot(shot, keyframes_dir)
            path = paths[0] if paths else keyframes_dir / primary_keyframe_name(sid)
            if not path.is_file():
                continue
            seen.add(sid)
            frames.append({"shot_id": sid, "path": str(path)})
        if not frames:
            continue
        jobs.append(
            {
                "eventId": eid,
                "title": str(ev.get("title") or ""),
                "summary": str(ev.get("summary") or ""),
                "frames": frames,
            }
        )
    return jobs


def attach_visual_evidence(
    knowledge: dict[str, Any],
    captions: dict[str, str],
    jobs: list[dict[str, Any]],
) -> dict[str, Any]:
    by_id = {str(j["eventId"]): j for j in jobs if j.get("eventId")}
    for ev in knowledge.get("events") or []:
        if not isinstance(ev, dict):
            continue
        eid = str(ev.get("eventId") or "")
        text = str(captions.get(eid) or "").strip()
        job = by_id.get(eid) or {}
        shot_ids = [int(f["shot_id"]) for f in (job.get("frames") or [])]
        ev["visualEvidence"] = text
        ev["vlmShotIds"] = shot_ids
        for c in ev.get("candidate_shots") or []:
            if not isinstance(c, dict):
                continue
            if int(c.get("shot_id") or c.get("id") or -1) in set(shot_ids) and text:
                c["vlm"] = True
    return knowledge


def describe_candidate_events(
    knowledge: dict[str, Any],
    *,
    shots: list[dict[str, Any]],
    work_dir: Path,
    cfg: dict[str, Any] | None = None,
    locale: str = "vi",
) -> dict[str, Any]:
    """Run Qwen2.5-VL on shortlisted frames. Skips (does not fail) when GPU/model missing."""
    vc = vlm_config(cfg)
    keyframes_dir = work_dir / "keyframes"
    jobs = collect_vlm_targets(
        knowledge,
        shots=shots,
        keyframes_dir=keyframes_dir,
        max_shots_per_event=int(vc["maxShotsPerEvent"]),
    )
    meta: dict[str, Any] = {
        "model": vc["model"],
        "enabled": vc["enabled"],
        "eventCount": len(jobs),
        "imageCount": sum(len(j["frames"]) for j in jobs),
        "skipped": False,
        "reason": "",
        "events": [],
    }
    if not vc["enabled"]:
        meta["skipped"] = True
        meta["reason"] = "vlmEnabled=false"
        return meta
    if not jobs:
        meta["skipped"] = True
        meta["reason"] = "no-candidate-keyframes"
        return meta

    loaded = _ensure_model(str(vc["model"]))
    if loaded is None:
        meta["skipped"] = True
        meta["reason"] = "model-unavailable"
        return meta

    captions: dict[str, str] = {}
    total = len(jobs)
    for i, job in enumerate(jobs):
        progress(LOG, "Qwen2.5-VL events", i, total, every=max(1, total // 8))
        text = _generate_event_caption(
            job,
            locale=locale,
            max_new_tokens=int(vc["maxNewTokens"]),
            max_side=int(vc["maxSide"]),
        )
        captions[str(job["eventId"])] = text
        meta["events"].append(
            {
                "eventId": job["eventId"],
                "title": job["title"],
                "shotIds": [f["shot_id"] for f in job["frames"]],
                "visualEvidence": text,
            }
        )
    attach_visual_evidence(knowledge, captions, jobs)
    return meta


def _ensure_model(name: str) -> tuple[Any, Any] | None:
    global _MODEL, _PROCESSOR, _MODEL_NAME
    if _MODEL is not None and _MODEL_NAME == name:
        return _MODEL, _PROCESSOR
    try:
        import torch
    except Exception as exc:
        LOG.warning("VLM skip: torch missing (%s)", exc)
        return None
    if not torch.cuda.is_available():
        LOG.warning("VLM skip: no CUDA (Qwen2.5-VL-3B is not run on CPU in this pipeline)")
        return None
    try:
        from transformers import AutoProcessor

        dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        kwargs: dict[str, Any] = {
            "trust_remote_code": True,
            "torch_dtype": dtype,
            "device_map": "auto",
        }
        model = None
        try:
            from transformers import Qwen2_5_VLForConditionalGeneration

            model = Qwen2_5_VLForConditionalGeneration.from_pretrained(name, **kwargs)
        except Exception:
            from transformers import AutoModelForImageTextToText

            model = AutoModelForImageTextToText.from_pretrained(name, **kwargs)
        processor = AutoProcessor.from_pretrained(name, trust_remote_code=True)
        model.eval()
        _MODEL, _PROCESSOR, _MODEL_NAME = model, processor, name
        LOG.info("Qwen2.5-VL loaded: %s", name)
        return _MODEL, _PROCESSOR
    except Exception as exc:
        LOG.warning("VLM skip: failed to load %s (%s)", name, exc)
        return None


def _load_rgb(path: Path, max_side: int):
    from PIL import Image

    im = Image.open(path).convert("RGB")
    w, h = im.size
    if max(w, h) > max_side:
        im.thumbnail((max_side, max_side))
    return im


def _generate_event_caption(
    job: dict[str, Any],
    *,
    locale: str,
    max_new_tokens: int,
    max_side: int,
) -> str:
    model, processor = _MODEL, _PROCESSOR
    frames = job.get("frames") or []
    images = []
    for f in frames:
        try:
            images.append(_load_rgb(Path(f["path"]), max_side))
        except Exception:
            continue
    if not images:
        return ""
    lang = "Vietnamese" if str(locale).startswith("vi") else "English"
    prompt = (
        f"Write in {lang}. These {len(images)} stills are candidate footage for one story event.\n"
        f"Event title: {job.get('title') or ''}\n"
        f"Event summary: {job.get('summary') or ''}\n"
        "Describe ONLY what is visible: people, actions, place, readable on-screen text. "
        "4–8 short lines. No camera jargon. Do not invent plot or names that are not visible."
    )
    content: list[dict[str, Any]] = [{"type": "image"} for _ in images]
    content.append({"type": "text", "text": prompt})
    messages = [{"role": "user", "content": content}]
    try:
        text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = processor(text=[text], images=images, padding=True, return_tensors="pt")
        device = next(model.parameters()).device
        inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}
        import torch

        with torch.no_grad():
            out = model.generate(**inputs, max_new_tokens=max(48, min(256, max_new_tokens)))
        trimmed = out[:, inputs["input_ids"].shape[1] :]
        decoded = processor.batch_decode(trimmed, skip_special_tokens=True)
        return str(decoded[0] if decoded else "").strip()[:1200]
    except Exception as exc:
        LOG.warning("VLM generate failed for %s (%s)", job.get("eventId"), exc)
        return ""
