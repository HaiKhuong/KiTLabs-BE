"""
Video workflow — TTS từng scene bằng omnivoice_tts (giống auto_vietsub Step3).

Stdin JSON:
  ref_audio, ref_text, model_id?, device_map?, dtype_str?, language?, num_step?, guidance_scale?, seed?,
  batch_size?, scenes: [{ sceneNumber, text, out_wav }]

Stdout JSON:
  { segments: [{ sceneNumber, ok, error? }] }
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from audio_tts_worker import resolve_device_map
import pipeline_cache  # noqa: F401 — HF cache → tools/video-pipeline/cache
from omnivoice_tts import (
    DEFAULT_OMNIVOICE_DENOISE,
    DEFAULT_OMNIVOICE_GUIDANCE_SCALE,
    DEFAULT_OMNIVOICE_NUM_STEP,
    DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT,
    DEFAULT_OMNIVOICE_PREPROCESS_PROMPT,
    resolve_omnivoice_batch_size,
    resolve_omnivoice_language,
    synthesize_many_to_wavs,
)


def _env_flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip().lower() in ("1", "true", "yes", "on")


def _payload_flag(payload: dict[str, Any], key: str, default: bool) -> bool:
    if key not in payload or payload.get(key) is None or str(payload.get(key)).strip() == "":
        return default
    val = payload.get(key)
    if isinstance(val, bool):
        return val
    return str(val).strip().lower() in ("1", "true", "yes", "on")


def _resolve_seed(raw: Any) -> int | None:
    if raw is None or str(raw).strip() == "":
        env = (os.getenv("OMNIVOICE_SEED") or "42").strip()
        if not env or env.lower() in ("none", "null"):
            return None
        try:
            return int(env)
        except ValueError:
            return 42
    try:
        return int(raw)
    except (TypeError, ValueError):
        return None


def main() -> None:
    payload = json.load(sys.stdin)
    ref_audio = str(Path(str(payload["ref_audio"])).expanduser().resolve())
    if not Path(ref_audio).is_file():
        raise FileNotFoundError(f"ref_audio not found: {ref_audio}")

    ref_text = str(payload.get("ref_text") or "")
    model_id = str(payload.get("model_id") or os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")).strip()
    device_map = resolve_device_map(str(payload.get("device_map") or os.getenv("OMNIVOICE_DEVICE_MAP") or ""))
    dtype_str = str(payload.get("dtype_str") or os.getenv("OMNIVOICE_DTYPE") or "float16").strip() or "float16"
    language_raw = payload.get("language") or os.getenv("OMNIVOICE_LANGUAGE")
    language = resolve_omnivoice_language(str(language_raw) if language_raw else None)
    num_step = int(
        payload.get("num_step") or os.getenv("OMNIVOICE_NUM_STEP") or DEFAULT_OMNIVOICE_NUM_STEP
    )
    guidance_scale = float(
        payload.get("guidance_scale")
        or os.getenv("OMNIVOICE_GUIDANCE_SCALE")
        or DEFAULT_OMNIVOICE_GUIDANCE_SCALE
    )
    denoise = _payload_flag(
        payload, "denoise", _env_flag("OMNIVOICE_DENOISE", DEFAULT_OMNIVOICE_DENOISE)
    )
    preprocess_prompt = _payload_flag(
        payload,
        "preprocess_prompt",
        _env_flag("OMNIVOICE_PREPROCESS_PROMPT", DEFAULT_OMNIVOICE_PREPROCESS_PROMPT),
    )
    postprocess_output = _payload_flag(
        payload,
        "postprocess_output",
        _env_flag("OMNIVOICE_POSTPROCESS_OUTPUT", DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT),
    )
    normalize_text = _payload_flag(
        payload,
        "normalize_text",
        _env_flag("OMNIVOICE_NORMALIZE_TEXT", False),
    )
    seed = _resolve_seed(payload.get("seed"))
    batch_size = resolve_omnivoice_batch_size(payload.get("batch_size"))

    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("scenes must be a non-empty array")

    omnivoice_kw = dict(
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        language=language,
        num_step=num_step if num_step > 0 else None,
        guidance_scale=guidance_scale if num_step > 0 else None,
        denoise=denoise,
        preprocess_prompt=preprocess_prompt,
        postprocess_output=postprocess_output,
        normalize_text=normalize_text,
        seed=seed,
    )

    results: list[dict[str, Any]] = []
    jobs: list[dict[str, Any]] = []
    job_scene_numbers: list[int] = []

    for item in scenes:
        if not isinstance(item, dict):
            continue
        scene_number = int(item.get("sceneNumber") or item.get("scene_number") or 0)
        text = str(item.get("text") or "").strip()
        out_wav = str(item.get("out_wav") or item.get("outWav") or "").strip()
        if not text or not out_wav:
            results.append(
                {
                    "sceneNumber": scene_number,
                    "ok": False,
                    "error": "missing text or out_wav",
                }
            )
            continue
        out_path = Path(out_wav)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        jobs.append({"text": text, "out_wav": str(out_path)})
        job_scene_numbers.append(scene_number)

    if jobs:
        try:
            synthesize_many_to_wavs(
                jobs,
                batch_size=batch_size,
                **omnivoice_kw,
            )
        except Exception as exc:
            for scene_number in job_scene_numbers:
                results.append(
                    {
                        "sceneNumber": scene_number,
                        "ok": False,
                        "error": str(exc) or exc.__class__.__name__,
                    }
                )
            json.dump({"segments": results}, sys.stdout, ensure_ascii=False)
            sys.stdout.write("\n")
            sys.stdout.flush()
            return

        for scene_number, job in zip(job_scene_numbers, jobs):
            out_path = Path(job["out_wav"])
            if out_path.is_file() and out_path.stat().st_size > 0:
                results.append({"sceneNumber": scene_number, "ok": True})
            else:
                results.append(
                    {
                        "sceneNumber": scene_number,
                        "ok": False,
                        "error": f"empty output: {out_path}",
                    }
                )

    json.dump({"segments": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
