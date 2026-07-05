"""
Video workflow — text-to-image per scene using FLUX.1 Schnell (diffusers).

Stdin JSON:
  model_id?, device_map?, dtype_str?, guidance_scale?, num_inference_steps?, max_sequence_length?, seed?,
  style?, aspect_ratio?,
  scenes: [{ sceneNumber, prompt, negative_prompt?, out_path }]

Stdout JSON:
  { images: [{ sceneNumber, ok, path?, error? }] }

Model: https://huggingface.co/black-forest-labs/FLUX.1-schnell
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from audio_tts_worker import resolve_device_map
from pipeline_cache import configure_omnivoice_cache_env

configure_omnivoice_cache_env()

_pipe = None


def _resolve_seed(raw: Any) -> int:
    if raw is None or str(raw).strip() == "":
        env = (os.getenv("FLUX_SEED") or "42").strip()
        try:
            return int(env)
        except ValueError:
            return 42
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 42


def _aspect_to_size(aspect_ratio: str) -> tuple[int, int]:
    """Map aspect ratio → pixel size (720p baseline, multiples of 16 for FLUX)."""
    key = str(aspect_ratio or "9:16").strip()
    mapping = {
        "9:16": (720, 1280),   # portrait 720p (Shorts)
        "16:9": (1280, 720),   # landscape 720p (HD)
        "1:1": (720, 720),
        "4:5": (576, 720),     # 4:5 with 720px height
    }
    return mapping.get(key, mapping["9:16"])


def _style_suffix(style: str) -> str:
    key = str(style or "cinematic").strip().lower()
    suffixes = {
        "cinematic": "cinematic lighting, film still, dramatic composition, high detail",
        "anime": "anime style, vibrant colors, clean line art",
        "realistic": "photorealistic, natural lighting, sharp focus",
        "illustration": "digital illustration, artistic, detailed",
        "3d": "3d render, octane render, soft lighting",
    }
    return suffixes.get(key, suffixes["cinematic"])


def _build_prompt(base: str, style: str) -> str:
    text = str(base or "").strip()
    if not text:
        return ""
    suffix = _style_suffix(style)
    return f"{text}, {suffix}" if suffix else text


def _resolve_dtype(dtype_str: str):
    import torch

    key = str(dtype_str or os.getenv("FLUX_DTYPE") or "bfloat16").strip().lower()
    if key in ("bf16", "bfloat16"):
        return torch.bfloat16
    if key in ("fp32", "float32"):
        return torch.float32
    return torch.float16


def _get_pipe(model_id: str, device_map: str, dtype_str: str):
    global _pipe
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import FluxPipeline

    dtype = _resolve_dtype(dtype_str)
    token = (os.getenv("FLUX_HF_TOKEN") or os.getenv("HUGGINGFACE_HUB_TOKEN") or "").strip() or None

    _pipe = FluxPipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
        token=token,
    )

    if device_map == "cpu":
        _pipe.to("cpu")
    elif device_map.startswith("cuda"):
        try:
            _pipe.to(device_map)
        except Exception:
            _pipe.enable_model_cpu_offload()
    else:
        _pipe.enable_model_cpu_offload()

    return _pipe


def main() -> None:
    payload = json.load(sys.stdin)
    model_id = str(
        payload.get("model_id") or os.getenv("FLUX_MODEL_ID") or "black-forest-labs/FLUX.1-schnell"
    ).strip()
    device_map = resolve_device_map(str(payload.get("device_map") or os.getenv("FLUX_DEVICE_MAP") or ""))
    dtype_str = str(payload.get("dtype_str") or os.getenv("FLUX_DTYPE") or "bfloat16").strip() or "bfloat16"
    guidance_scale = float(payload.get("guidance_scale") or os.getenv("FLUX_GUIDANCE_SCALE") or 0.0)
    num_steps = int(payload.get("num_inference_steps") or os.getenv("FLUX_NUM_INFERENCE_STEPS") or 4)
    max_sequence_length = int(
        payload.get("max_sequence_length") or os.getenv("FLUX_MAX_SEQUENCE_LENGTH") or 256
    )
    seed = _resolve_seed(payload.get("seed"))
    style = str(payload.get("style") or "cinematic")
    aspect_ratio = str(payload.get("aspect_ratio") or "9:16")
    width, height = _aspect_to_size(aspect_ratio)

    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("scenes must be a non-empty array")

    import torch

    pipe = _get_pipe(model_id, device_map, dtype_str)
    generator = torch.Generator("cpu").manual_seed(seed)

    results: list[dict[str, Any]] = []
    for item in scenes:
        if not isinstance(item, dict):
            continue
        scene_number = int(item.get("sceneNumber") or item.get("scene_number") or 0)
        prompt = _build_prompt(str(item.get("prompt") or ""), style)
        out_path_raw = str(item.get("out_path") or item.get("outPath") or "").strip()
        if not prompt or not out_path_raw:
            results.append(
                {
                    "sceneNumber": scene_number,
                    "ok": False,
                    "error": "missing prompt or out_path",
                }
            )
            continue

        out_path = Path(out_path_raw)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            output = pipe(
                prompt,
                guidance_scale=guidance_scale,
                num_inference_steps=max(1, num_steps),
                max_sequence_length=max_sequence_length,
                width=width,
                height=height,
                generator=generator,
            )
            image = output.images[0]
            image.save(out_path, format="PNG")
            if not out_path.is_file() or out_path.stat().st_size <= 0:
                raise RuntimeError(f"empty output: {out_path}")
            results.append({"sceneNumber": scene_number, "ok": True, "path": str(out_path.resolve())})
        except Exception as exc:
            results.append(
                {
                    "sceneNumber": scene_number,
                    "ok": False,
                    "error": str(exc) or exc.__class__.__name__,
                }
            )

    json.dump({"images": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
