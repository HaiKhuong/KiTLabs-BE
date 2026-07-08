"""
Video workflow — text-to-image per scene using Z-Image-Turbo (diffusers, local GPU).

Stdin JSON (same contract as video_image_flux.py):
  model_id?, device_map?, dtype_str?, num_inference_steps?, seed?,
  style?, aspect_ratio?,
  scenes: [{ sceneNumber, prompt, negative_prompt?, out_path }]

Stdout JSON:
  { images: [{ sceneNumber, ok, path?, error?, enrichedPrompt?, geminiAnalysis? }] }

Model: https://huggingface.co/Tongyi-MAI/Z-Image-Turbo
  - 6B params, bfloat16, fits ~16GB VRAM
  - 8 DiT forwards (num_inference_steps=9), guidance_scale=0.0
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from typing import Any

from audio_tts_worker import resolve_device_map
import flux_cache  # noqa: F401
from flux_cache import resolve_hf_token
from video_image_flux import (
    _enrich_prompt,
    _resolve_seed,
    _get_vram_gb,
    _log_runtime_device,
)

_pipe = None

Z_IMAGE_MODEL_ID = "Tongyi-MAI/Z-Image-Turbo"


def _resolve_model_id(raw: Any) -> str:
    return str(raw or os.getenv("Z_IMAGE_MODEL_ID") or Z_IMAGE_MODEL_ID).strip()


def _resolve_dtype(dtype_str: str):
    import torch

    key = str(dtype_str or os.getenv("Z_IMAGE_DTYPE") or os.getenv("FLUX_DTYPE") or "bfloat16").strip().lower()
    if key in ("fp16", "float16"):
        return torch.float16
    if key in ("fp32", "float32"):
        return torch.float32
    return torch.bfloat16


def _resolve_num_steps(raw: Any) -> int:
    value = raw if raw is not None else (
        os.getenv("Z_IMAGE_NUM_INFERENCE_STEPS") or os.getenv("FLUX_NUM_INFERENCE_STEPS") or 9
    )
    try:
        steps = int(value)
    except (TypeError, ValueError):
        steps = 9
    return max(1, min(12, steps))


def _allow_cpu() -> bool:
    return str(
        os.getenv("Z_IMAGE_ALLOW_CPU") or os.getenv("FLUX_ALLOW_CPU") or ""
    ).strip().lower() in ("1", "true", "yes")


def _resolve_offload_mode(device_map: str) -> str:
    """
    Z-Image-Turbo 6B bf16 ~12GB — vừa card 16GB, cần offload cho 12GB.
    """
    raw = str(os.getenv("Z_IMAGE_OFFLOAD") or os.getenv("FLUX_OFFLOAD") or "auto").strip().lower()
    if device_map == "cpu":
        return "cpu"

    if raw in ("sequential", "model"):
        return raw
    if raw == "cuda":
        return "cuda"

    vram = _get_vram_gb()
    if vram is not None and vram <= 12.5:
        print(
            f"[zimage] VRAM ~{vram:.1f} GiB — model_cpu_offload (model 6B ~12GB bf16)",
            file=sys.stderr,
        )
        return "model"
    return "cuda"


def _gpu_index(device_map: str) -> int:
    if device_map.startswith("cuda:"):
        try:
            return int(device_map.split(":", 1)[1])
        except ValueError:
            return 0
    return 0


def _apply_pipe_memory_opts(pipe: Any, offload_mode: str, device_map: str) -> None:
    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    elif getattr(pipe, "vae", None) is not None and hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()

    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    elif getattr(pipe, "vae", None) is not None and hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()

    gpu_id = _gpu_index(device_map)
    if offload_mode == "sequential":
        pipe.enable_sequential_cpu_offload(gpu_id=gpu_id)
        print(f"[zimage] sequential_cpu_offload (gpu_id={gpu_id})", file=sys.stderr)
    elif offload_mode == "model":
        pipe.enable_model_cpu_offload(gpu_id=gpu_id)
        print(f"[zimage] model_cpu_offload (gpu_id={gpu_id})", file=sys.stderr)
    elif offload_mode == "cuda":
        pipe.to(device_map)
        print(f"[zimage] full GPU {device_map}", file=sys.stderr)
    else:
        pipe.to("cpu")


def _aspect_to_size(aspect_ratio: str) -> tuple[int, int]:
    """Map aspect ratio → pixel size (multiples of 16)."""
    key = str(aspect_ratio or "9:16").strip()
    mapping = {
        "9:16": (768, 1344),
        "16:9": (1344, 768),
        "1:1": (1024, 1024),
        "4:5": (896, 1088),
    }
    return mapping.get(key, mapping["9:16"])


def _cache_has_model(model_id: str) -> bool:
    hub = Path(
        os.environ.get("HUGGINGFACE_HUB_CACHE")
        or (flux_cache.FLUX_CACHE_ROOT / "huggingface" / "hub")
    )
    safe = model_id.replace("/", "--")
    snap_root = hub / f"models--{safe}" / "snapshots"
    if not snap_root.is_dir():
        return False
    for snap in snap_root.iterdir():
        if not snap.is_dir():
            continue
        for path in snap.rglob("*.safetensors"):
            if path.stat().st_size > 100_000_000:
                return True
    return False


def _get_pipe(model_id: str, device_map: str, dtype_str: str):
    global _pipe
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import ZImagePipeline

    dtype = _resolve_dtype(dtype_str)
    token = resolve_hf_token()
    _log_runtime_device(device_map)

    cuda_requested = device_map.startswith("cuda")
    cuda_available = False
    try:
        cuda_available = torch.cuda.is_available()
    except Exception:
        pass

    if cuda_requested and not cuda_available:
        raise RuntimeError(
            f"Z_IMAGE_DEVICE_MAP={device_map} nhưng CUDA không khả dụng. "
            "Kiểm tra driver / WSL GPU passthrough."
        )

    if device_map == "cpu" and not _allow_cpu():
        raise RuntimeError(
            "Z-Image-Turbo nên dùng GPU. CPU quá chậm. "
            "Đặt Z_IMAGE_DEVICE_MAP=cuda:0 hoặc Z_IMAGE_ALLOW_CPU=1 nếu chấp nhận chậm."
        )

    if token:
        print(f"[zimage] HF_TOKEN có ({len(token)} ký tự)", file=sys.stderr)
        try:
            from huggingface_hub import login
            login(token=token, add_to_git_credential=False)
        except Exception as exc:
            print(f"[zimage] WARN: huggingface_hub.login thất bại: {exc}", file=sys.stderr)
    else:
        print("[zimage] WARN: HF_TOKEN trống", file=sys.stderr)

    offload_mode = _resolve_offload_mode(device_map)
    vram_gb = _get_vram_gb()
    if vram_gb is not None:
        print(f"[zimage] offload={offload_mode} (VRAM ~{vram_gb:.1f} GiB)", file=sys.stderr)

    is_first_download = not _cache_has_model(model_id)
    if is_first_download:
        print(
            f"[zimage] Lần đầu tải model {model_id} từ Hugging Face — có thể mất vài phút…",
            file=sys.stderr,
        )
    else:
        print(
            f"[zimage] Cache local đã có — load {model_id} từ disk",
            file=sys.stderr,
        )

    load_started = time.monotonic()
    print(f"[zimage] Đang load {model_id} (dtype={dtype_str})…", file=sys.stderr)

    _pipe = ZImagePipeline.from_pretrained(
        model_id,
        torch_dtype=dtype,
        token=token,
        low_cpu_mem_usage=not cuda_available,
    )

    if offload_mode != "cpu":
        _apply_pipe_memory_opts(_pipe, offload_mode, device_map)
    else:
        _pipe.to("cpu")

    load_elapsed = time.monotonic() - load_started
    label = "Tải model lần đầu" if is_first_download else "Load model từ cache"
    print(
        f"[zimage] {label} xong ({load_elapsed:.1f}s) — {model_id} sẵn sàng infer",
        file=sys.stderr,
    )

    return _pipe


def main() -> None:
    payload = json.load(sys.stdin)
    model_id = _resolve_model_id(payload.get("model_id"))
    device_map = resolve_device_map(
        str(payload.get("device_map") or os.getenv("Z_IMAGE_DEVICE_MAP") or os.getenv("FLUX_DEVICE_MAP") or "")
    )
    dtype_str = str(
        payload.get("dtype_str") or os.getenv("Z_IMAGE_DTYPE") or os.getenv("FLUX_DTYPE") or "bfloat16"
    ).strip() or "bfloat16"
    num_steps = _resolve_num_steps(payload.get("num_inference_steps"))
    seed = _resolve_seed(payload.get("seed"))
    style = str(payload.get("style") or "anime")
    aspect_ratio = str(payload.get("aspect_ratio") or "9:16")
    width, height = _aspect_to_size(aspect_ratio)

    print(
        f"[zimage] model={model_id!r} style={style!r} aspect={aspect_ratio} "
        f"size={width}×{height} steps={num_steps} dtype={dtype_str}",
        file=sys.stderr,
    )

    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise ValueError("scenes must be a non-empty array")

    import torch

    pipe = _get_pipe(model_id, device_map, dtype_str)
    use_cuda_gen = torch.cuda.is_available() and not device_map.startswith("cpu")

    results: list[dict[str, Any]] = []
    for item in scenes:
        if not isinstance(item, dict):
            continue

        scene_number = int(item.get("sceneNumber") or item.get("scene_number") or 0)
        raw_prompt = str(item.get("prompt") or "").strip()
        out_path_raw = str(item.get("out_path") or item.get("outPath") or "").strip()
        negative_prompt = str(item.get("negative_prompt") or "").strip()

        enriched = _enrich_prompt(raw_prompt, negative_prompt, style)
        prompt = enriched.prompt

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
        scene_seed = seed + scene_number
        gen_device = "cuda" if use_cuda_gen else "cpu"
        generator = torch.Generator(gen_device).manual_seed(scene_seed)

        try:
            if torch.cuda.is_available():
                torch.cuda.reset_peak_memory_stats()
            with torch.inference_mode():
                output = pipe(
                    prompt=prompt,
                    width=width,
                    height=height,
                    num_inference_steps=max(1, num_steps),
                    guidance_scale=0.0,
                    generator=generator,
                )
            image = output.images[0]
            image.save(out_path, format="PNG")
            if torch.cuda.is_available():
                peak_gb = torch.cuda.max_memory_allocated() / (1024**3)
                print(f"[zimage] scene {scene_number} peak VRAM ~{peak_gb:.2f} GiB", file=sys.stderr)
                torch.cuda.reset_peak_memory_stats()
                torch.cuda.empty_cache()
            if not out_path.is_file() or out_path.stat().st_size <= 0:
                raise RuntimeError(f"empty output: {out_path}")

            results.append(
                {
                    "sceneNumber": scene_number,
                    "ok": True,
                    "path": str(out_path.resolve()),
                    "enrichedPrompt": prompt,
                    "geminiAnalysis": enriched.gemini_analysis,
                }
            )
            print(f"[zimage] scene {scene_number} OK → {out_path}", file=sys.stderr)
        except Exception as exc:
            results.append(
                {
                    "sceneNumber": scene_number,
                    "ok": False,
                    "error": str(exc) or exc.__class__.__name__,
                }
            )
            print(f"[zimage] scene {scene_number} FAILED: {exc}", file=sys.stderr)

    json.dump({"images": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
