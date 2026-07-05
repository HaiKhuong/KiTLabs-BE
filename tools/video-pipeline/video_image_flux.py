"""
Video workflow — text-to-image per scene using FLUX.1 Schnell (diffusers).

Cache cố định: tools/video-pipeline/cache/flux — flux_cache.py

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
import flux_cache  # noqa: F401 — cache/flux
from flux_cache import resolve_hf_token

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


def _get_vram_gb() -> float | None:
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.get_device_properties(0).total_memory / (1024**3)
    except Exception:
        pass
    return None


def _resolve_offload_mode(device_map: str) -> str:
    """cuda | model | sequential — auto sequential khi VRAM ≤12.5 GiB (RTX 3060)."""
    raw = str(os.getenv("FLUX_OFFLOAD") or "").strip().lower()
    if raw in ("cuda", "model", "sequential"):
        return raw
    if device_map == "cpu":
        return "cpu"
    vram = _get_vram_gb()
    if vram is not None and vram <= 12.5:
        return "sequential"
    if vram is not None and vram <= 16:
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
    import sys

    if hasattr(pipe, "enable_vae_slicing"):
        pipe.enable_vae_slicing()
    elif getattr(pipe, "vae", None) is not None and hasattr(pipe.vae, "enable_slicing"):
        pipe.vae.enable_slicing()

    if hasattr(pipe, "enable_vae_tiling"):
        pipe.enable_vae_tiling()
    elif getattr(pipe, "vae", None) is not None and hasattr(pipe.vae, "enable_tiling"):
        pipe.vae.enable_tiling()

    if hasattr(pipe, "enable_attention_slicing"):
        try:
            pipe.enable_attention_slicing()
        except Exception as exc:
            print(f"[flux] WARN: attention_slicing: {exc}", file=sys.stderr)

    gpu_id = _gpu_index(device_map)
    if offload_mode == "sequential":
        pipe.enable_sequential_cpu_offload(gpu_id=gpu_id)
        print(
            "[flux] sequential_cpu_offload — VRAM thấp, ít ngốn RAM hơn model_offload; "
            "GPU % thấp là bình thường (chờ copy CPU→GPU).",
            file=sys.stderr,
        )
    elif offload_mode == "model":
        pipe.enable_model_cpu_offload(gpu_id=gpu_id)
        print(
            "[flux] model_cpu_offload — weights trên RAM (~24GB), VRAM đầy + disk 100% "
            "thường do swap; cân nhắc FLUX_OFFLOAD=sequential.",
            file=sys.stderr,
        )
    elif offload_mode == "cuda":
        pipe.to(device_map)
        print(f"[flux] full GPU {device_map}", file=sys.stderr)
    else:
        pipe.to("cpu")


def _aspect_to_size(aspect_ratio: str, vram_gb: float | None = None) -> tuple[int, int]:
    """Map aspect ratio → pixel size (720p baseline, multiples of 16 for FLUX)."""
    key = str(aspect_ratio or "9:16").strip()
    mapping = {
        "9:16": (720, 1280),   # portrait 720p (Shorts)
        "16:9": (1280, 720),   # landscape 720p (HD)
        "1:1": (720, 720),
        "4:5": (576, 720),     # 4:5 with 720px height
    }
    w, h = mapping.get(key, mapping["9:16"])

    # RTX 3060 12GB: 1280×720 dễ swap — hạ cạnh dài ~896px
    if vram_gb is not None and vram_gb <= 12.5:
        long_edge = max(w, h)
        cap = int(os.getenv("FLUX_MAX_LONG_EDGE") or "896")
        if long_edge > cap:
            scale = cap / long_edge
            w = max(16, int(round(w * scale / 16)) * 16)
            h = max(16, int(round(h * scale / 16)) * 16)
    return w, h


def _style_suffix(style: str) -> str:
    # Đồng bộ IMAGE_STYLE_OPTIONS (KiTLabs images.constants.ts)
    key = str(style or "anime").strip().lower()
    suffixes = {
        "anime": (
            "high-quality anime illustration, clean line art, expressive characters, "
            "vibrant colors, cel shading, dynamic composition, crisp details, "
            "2D animation style, soft lighting"
        ),
        "minimalist_illustration": (
            "minimalist flat illustration, clean composition, simple geometric shapes, "
            "limited color palette, soft muted colors, subtle gradients, "
            "large negative space, uncluttered design, modern editorial illustration"
        ),
        "stick_figure": (
            "minimal stick figure illustration, round head, simple line limbs, "
            "clear expressive poses, clean vector line art, flat colors, "
            "minimal background, educational infographic style, motion-graphics friendly"
        ),
        "kurzgesagt": (
            "modern flat vector illustration, educational infographic, "
            "simple geometric shapes, circles, rounded rectangles and clean curves, "
            "bold vibrant color palette with harmonious blue, orange, yellow, red and purple tones, "
            "flat colors with subtle smooth gradients, minimal shading with one or two shadow layers, "
            "clean crisp edges, minimal or no outlines, "
            "high visual clarity, simplified objects without unnecessary details, "
            "single clear focal subject, uncluttered background, "
            "balanced composition, motion-graphics friendly, "
            "2D vector artwork, SVG-style, no textures, no photorealism"
        ),
    }
    return suffixes.get(key, suffixes["anime"])


def _build_prompt(base: str, style: str) -> str:
    text = str(base or "").strip()
    if not text:
        return ""
    suffix = _style_suffix(style)
    return f"{text}, {suffix}" if suffix else text


def _resolve_dtype(dtype_str: str):
    import torch

    key = str(dtype_str or os.getenv("FLUX_DTYPE") or "float16").strip().lower()
    if key in ("bf16", "bfloat16"):
        return torch.bfloat16
    if key in ("fp32", "float32"):
        return torch.float32
    return torch.float16


def _allow_cpu() -> bool:
    return str(os.getenv("FLUX_ALLOW_CPU") or "").strip().lower() in ("1", "true", "yes")


def _log_runtime_device(device_map: str) -> None:
    import sys

    try:
        import torch

        cuda_ok = torch.cuda.is_available()
        if cuda_ok:
            name = torch.cuda.get_device_name(0)
            vram_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            print(f"[flux] CUDA OK — {name}, VRAM ~{vram_gb:.1f} GiB, device_map={device_map}", file=sys.stderr)
        else:
            print(f"[flux] CUDA không khả dụng — device_map={device_map}", file=sys.stderr)
    except Exception as exc:
        print(f"[flux] WARN: không đọc được thông tin GPU: {exc}", file=sys.stderr)


def _hub_model_cache_dir(model_id: str) -> Path:
    hub = Path(os.environ.get("HUGGINGFACE_HUB_CACHE") or (flux_cache.FLUX_CACHE_ROOT / "huggingface" / "hub"))
    safe = model_id.replace("/", "--")
    return hub / f"models--{safe}"


def _cache_has_complete_model(model_id: str) -> bool:
    """True nếu đã có ít nhất một snapshot với weight files (không chỉ metadata)."""
    snap_root = _hub_model_cache_dir(model_id) / "snapshots"
    if not snap_root.is_dir():
        return False
    weight_names = (
        "flux1-schnell.safetensors",
        "diffusion_pytorch_model.safetensors",
        "model.safetensors",
    )
    for snap in snap_root.iterdir():
        if not snap.is_dir():
            continue
        for name in weight_names:
            if (snap / name).is_file() and (snap / name).stat().st_size > 1_000_000:
                return True
        # Bất kỳ file .safetensors lớn nào trong snapshot
        for path in snap.rglob("*.safetensors"):
            if path.stat().st_size > 100_000_000:
                return True
    return False


def _resolve_local_files_only(model_id: str) -> bool:
    """
    Sau lần tải đầu: chỉ đọc cache, không gọi Hub (tránh tải thêm / snapshot mới).
  FLUX_LOCAL_FILES_ONLY=0|1 ghi đè; mặc định auto.
    """
    raw = str(os.getenv("FLUX_LOCAL_FILES_ONLY") or "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return _cache_has_complete_model(model_id)


def _get_pipe(model_id: str, device_map: str, dtype_str: str):
    global _pipe
    if _pipe is not None:
        return _pipe

    import torch
    from diffusers import FluxPipeline

    import sys

    dtype = _resolve_dtype(dtype_str)
    token = resolve_hf_token()
    _log_runtime_device(device_map)

    cuda_requested = device_map.startswith("cuda")
    cuda_available = False
    try:
        import torch as _torch

        cuda_available = _torch.cuda.is_available()
    except Exception:
        cuda_available = False

    if cuda_requested and not cuda_available:
        raise RuntimeError(
            f"FLUX_DEVICE_MAP={device_map} nhưng CUDA không khả dụng trong Python. "
            "WSL cần GPU passthrough (nvidia-smi trong WSL). Không fallback CPU — tránh OOM."
        )

    if device_map == "cpu" and not _allow_cpu():
        raise RuntimeError(
            "FLUX.1-schnell cần GPU (CUDA). CPU bị tắt vì dễ OOM (~24GB+ RAM). "
            "Cài CUDA + đặt FLUX_DEVICE_MAP=cuda:0, hoặc FLUX_ALLOW_CPU=1 nếu máy đủ RAM."
        )

    if token:
        print(f"[flux] HF_TOKEN có ({len(token)} ký tự)", file=sys.stderr)
        try:
            from huggingface_hub import login

            login(token=token, add_to_git_credential=False)
        except Exception as login_exc:
            print(f"[flux] WARN: huggingface_hub.login thất bại: {login_exc}", file=sys.stderr)
    else:
        print("[flux] WARN: HF_TOKEN trống — gated model sẽ 403", file=sys.stderr)

    print(f"[flux] Đang load model {model_id} (dtype={dtype_str})…", file=sys.stderr)
    offload_mode = _resolve_offload_mode(device_map)
    vram_gb = _get_vram_gb()
    if vram_gb is not None:
        print(f"[flux] offload={offload_mode} (VRAM ~{vram_gb:.1f} GiB)", file=sys.stderr)

    local_files_only = _resolve_local_files_only(model_id)
    if local_files_only:
        print(
            "[flux] Cache local đã có — local_files_only=True (không download Hub, chỉ đọc disk)",
            file=sys.stderr,
        )
    else:
        print(
            "[flux] Chưa có cache đủ weights — lần này sẽ tải từ Hugging Face (một lần, ~23GiB)",
            file=sys.stderr,
        )

    try:
        _pipe = FluxPipeline.from_pretrained(
            model_id,
            torch_dtype=dtype,
            token=token,
            low_cpu_mem_usage=True,
            local_files_only=local_files_only,
        )
    except Exception as exc:
        err = str(exc)
        if "GatedRepoError" in exc.__class__.__name__ or "gated repo" in err.lower():
            if token:
                raise RuntimeError(
                    "FLUX.1-schnell: token HF đã có nhưng tài khoản chưa được duyệt. "
                    "Đăng nhập Hugging Face bằng đúng tài khoản tạo token, mở "
                    "https://huggingface.co/black-forest-labs/FLUX.1-schnell → Accept license, "
                    "rồi thử lại (token Read, restart Nest sau khi sửa .env)."
                ) from exc
            raise RuntimeError(
                "FLUX.1-schnell là model gated. Thêm HF_TOKEN=hf_... vào .env Nest, "
                "restart service, và Accept license tại "
                "https://huggingface.co/black-forest-labs/FLUX.1-schnell"
            ) from exc
        raise

    if offload_mode != "cpu":
        _apply_pipe_memory_opts(_pipe, offload_mode, device_map)
    else:
        _pipe.to("cpu")

    return _pipe


def main() -> None:
    payload = json.load(sys.stdin)
    model_id = str(
        payload.get("model_id") or os.getenv("FLUX_MODEL_ID") or "black-forest-labs/FLUX.1-schnell"
    ).strip()
    device_map = resolve_device_map(str(payload.get("device_map") or os.getenv("FLUX_DEVICE_MAP") or ""))
    dtype_str = str(payload.get("dtype_str") or os.getenv("FLUX_DTYPE") or "float16").strip() or "float16"
    guidance_scale = float(payload.get("guidance_scale") or os.getenv("FLUX_GUIDANCE_SCALE") or 0.0)
    num_steps = int(payload.get("num_inference_steps") or os.getenv("FLUX_NUM_INFERENCE_STEPS") or 4)
    max_sequence_length = int(
        payload.get("max_sequence_length") or os.getenv("FLUX_MAX_SEQUENCE_LENGTH") or 256
    )
    seed = _resolve_seed(payload.get("seed"))
    style = str(payload.get("style") or "anime")
    print(f"[flux] style={style!r}", file=sys.stderr)
    aspect_ratio = str(payload.get("aspect_ratio") or "9:16")
    vram_gb = _get_vram_gb()
    width, height = _aspect_to_size(aspect_ratio, vram_gb)
    if vram_gb is not None and vram_gb <= 12.5:
        print(
            f"[flux] VRAM ≤12.5 GiB — size {width}×{height} (aspect {aspect_ratio}); "
            f"đặt FLUX_MAX_LONG_EDGE=1024 nếu muốn lớn hơn",
            file=sys.stderr,
        )

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
            with torch.inference_mode():
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
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
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
