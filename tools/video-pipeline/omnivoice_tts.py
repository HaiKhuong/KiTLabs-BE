"""
OmniVoice TTS (k2-fsa/OmniVoice, package omnivoice>=0.2.1) — dùng cho Step3 trong auto_vietsub_pro.

Cài: pip install "omnivoice>=0.2.1"
Tham khảo: https://huggingface.co/k2-fsa/OmniVoice

⚠️ QUAN TRỌNG - VOICE CONSISTENCY:
- Module này sử dụng CACHING để đảm bảo tone giọng ổn định giữa các câu
- Voice clone prompt được tạo một lần và tái sử dụng cho tất cả các câu
- KHÔNG reset cache giữa các câu trong cùng một video để giữ tone giọng nhất quán
- Chỉ reset cache khi cần đổi giọng mẫu: reset_omnivoice_session()

📝 CÁCH HOẠT ĐỘNG:
1. Lần đầu tiên gọi synthesize_to_wav() với ref_audio/ref_text:
   - Model được load và cache (theo model_id, device, dtype)
   - Voice clone prompt được tạo và cache (theo ref_audio path + ref_text)
2. Các lần gọi tiếp theo với cùng ref_audio/ref_text:
   - Tái sử dụng model và voice prompt đã cache
   - Đảm bảo tone giọng nhất quán 100%
3. Nếu đổi ref_audio hoặc ref_text:
   - Voice prompt tự động được tạo lại và cache mới
   - Model vẫn được giữ nếu model_id/device/dtype không đổi
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Optional, Sequence, Tuple, Union

import pipeline_cache  # noqa: F401 — HF cache → tools/video-pipeline/cache

from tts_text_normalize import ensure_tts_trailing_period, prepare_tts_input_text, sanitize_tts_unicode

# Cache theo (model_id, device_map, dtype_str)
_session_model: Optional[Any] = None
_session_model_key: Optional[Tuple[str, str, str]] = None
# Cache prompt theo (resolved ref_audio, ref_text, preprocess_prompt) + dict multi-voice
_session_prompt: Optional[Any] = None
_session_prompt_key: Optional[Tuple[str, str, bool]] = None
_session_prompts: dict[Tuple[str, int, int, str, bool, str], Any] = {}

# Defaults khớp OmniVoice demo / OmniVoiceGenerationConfig upstream (0.2.x)
DEFAULT_OMNIVOICE_NUM_STEP = 32
DEFAULT_OMNIVOICE_GUIDANCE_SCALE = 2.0
DEFAULT_OMNIVOICE_DENOISE = True
DEFAULT_OMNIVOICE_PREPROCESS_PROMPT = True
DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT = True
DEFAULT_OMNIVOICE_BATCH_SIZE = 8

SUPPORTED_OMNIVOICE_LANGUAGES = ("vietnamese", "english", "korean", "japanese")

_OMNIVOICE_LANGUAGE_ALIASES: dict[str, str] = {
    "vietnamese": "vietnamese",
    "vi": "vietnamese",
    "vie": "vietnamese",
    "english": "english",
    "en": "english",
    "eng": "english",
    "korean": "korean",
    "ko": "korean",
    "kor": "korean",
    "japanese": "japanese",
    "ja": "japanese",
    "jpn": "japanese",
}


def resolve_omnivoice_language(raw: str | None) -> str:
    """Chuẩn hóa language OmniVoice — bắt buộc truyền, không mặc định vietnamese."""
    key = str(raw or "").strip().lower().replace("-", "_")
    if not key:
        supported = ", ".join(SUPPORTED_OMNIVOICE_LANGUAGES)
        raise ValueError(f"omnivoice: thiếu language (hỗ trợ: {supported})")
    resolved = _OMNIVOICE_LANGUAGE_ALIASES.get(key)
    if not resolved:
        supported = ", ".join(SUPPORTED_OMNIVOICE_LANGUAGES)
        raise ValueError(f"omnivoice: language không hỗ trợ {raw!r} (hỗ trợ: {supported})")
    return resolved


def resolve_omnivoice_batch_size(raw: Union[str, int, None] = None) -> int:
    """Chuẩn hóa batch size OmniVoice (>= 1). Env ``OMNIVOICE_BATCH_SIZE`` khi raw None."""
    if raw is None or str(raw).strip() == "":
        env = os.getenv("OMNIVOICE_BATCH_SIZE")
        if env is None or str(env).strip() == "":
            n = int(DEFAULT_OMNIVOICE_BATCH_SIZE)
        else:
            try:
                n = int(env)
            except (TypeError, ValueError):
                raise ValueError(f"omnivoice: batch_size không hợp lệ: {env!r}")
    else:
        try:
            n = int(raw)
        except (TypeError, ValueError):
            raise ValueError(f"omnivoice: batch_size không hợp lệ: {raw!r}")
    n = max(1, n)
    try:
        import torch

        if torch.cuda.is_available():
            total_gb = torch.cuda.get_device_properties(0).total_memory / (1024**3)
            # Trên GPU <= 6.5 GB VRAM (vd RTX 3050 4GB/6GB), giới hạn batch <= 4 để tránh tràn sang Shared RAM.
            if total_gb <= 6.5:
                n = min(n, 4)
    except Exception:
        pass
    return n


def resolve_omnivoice_num_step(raw: Union[str, int, None] = None) -> int:
    """Chuẩn hóa số bước lặp OmniVoice từ arg hoặc env ``OMNIVOICE_NUM_STEP`` (Settings)."""
    if raw is None or str(raw).strip() == "":
        env = os.getenv("OMNIVOICE_NUM_STEP")
        if env is None or str(env).strip() == "":
            return int(DEFAULT_OMNIVOICE_NUM_STEP)
        raw = env
    try:
        n = int(raw)
    except (TypeError, ValueError):
        return int(DEFAULT_OMNIVOICE_NUM_STEP)
    return max(1, n)


def resolve_omnivoice_guidance_scale(raw: Union[str, float, int, None] = None) -> float:
    """Chuẩn hóa CFG scale OmniVoice từ arg hoặc env ``OMNIVOICE_GUIDANCE_SCALE`` (Settings)."""
    if raw is None or str(raw).strip() == "":
        env = os.getenv("OMNIVOICE_GUIDANCE_SCALE")
        if env is None or str(env).strip() == "":
            return float(DEFAULT_OMNIVOICE_GUIDANCE_SCALE)
        raw = env
    try:
        val = float(raw)
    except (TypeError, ValueError):
        return float(DEFAULT_OMNIVOICE_GUIDANCE_SCALE)
    return max(0.0, val)


def _resolve_hf_token() -> str:
    # Ưu tiên HF_TOKEN; fallback các tên env phổ biến.
    token = (
        os.getenv("HF_TOKEN")
        or os.getenv("HUGGINGFACE_HUB_TOKEN")
        or os.getenv("HUGGING_FACE_HUB_TOKEN")
        or ""
    )
    token = str(token).strip()
    if token:
        # Đồng bộ để các lib HF downstream dùng cùng token.
        os.environ.setdefault("HF_TOKEN", token)
        os.environ.setdefault("HUGGINGFACE_HUB_TOKEN", token)
    return token


def reset_omnivoice_session() -> None:
    """Xoá cache model/prompt (vd. đổi checkpoint hoặc giọng mẫu giữa các lần chạy trong cùng process)."""
    global _session_model, _session_model_key, _session_prompt, _session_prompt_key
    _session_model = None
    _session_model_key = None
    _session_prompt = None
    _session_prompt_key = None
    _session_prompts.clear()
    try:
        import gc
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def prepare_omnivoice_input_text(
    text: str,
    language: str | None = None,
    *,
    vinorm_enabled: bool = False,
) -> str:
    """Chuẩn hóa text OmniVoice — dùng pipeline chung ``tts_text_normalize``."""
    lang = resolve_omnivoice_language(language) if language else None
    return prepare_tts_input_text(text, lang, vinorm_enabled=vinorm_enabled)


def _resolve_dtype(dtype_str: str):
    import torch

    s = (dtype_str or "float16").strip().lower()
    if s in ("float16", "fp16"):
        return torch.float16
    if s in ("bfloat16", "bf16"):
        return torch.bfloat16
    if s in ("float32", "fp32"):
        return torch.float32
    raise ValueError(f"omnivoice: dtype không hỗ trợ: {dtype_str!r}")


def _ensure_cuda_and_tf32(device_map: str | None = None) -> None:
    if device_map and str(device_map).strip().lower() == "cpu":
        return
    try:
        from cuda_dlls import ensure_windows_cuda_dlls

        ensure_windows_cuda_dlls()
    except Exception:
        pass
    try:
        import torch

        if torch.cuda.is_available():
            torch.backends.cuda.matmul.allow_tf32 = True
            torch.backends.cudnn.allow_tf32 = True
            if hasattr(torch, "set_float32_matmul_precision"):
                torch.set_float32_matmul_precision("high")
    except Exception:
        pass


def resolve_omnivoice_device_map(raw: str | None = None) -> str:
    """Chọn device: env/arg → cuda nếu có GPU, ngược lại cpu."""
    s = str(raw if raw is not None else os.getenv("OMNIVOICE_DEVICE_MAP") or "").strip()
    _ensure_cuda_and_tf32(s)
    try:
        import torch

        cuda_ok = torch.cuda.is_available()
    except Exception:
        cuda_ok = False

    if s:
        low = s.lower()
        if low.startswith("cuda") or low == "gpu":
            return "cuda:0" if cuda_ok else "cpu"
        return s

    return "cuda:0" if cuda_ok else "cpu"


def resolve_omnivoice_dtype(dtype_str: str | None, device_map: str | None = None) -> str:
    """CPU dùng float32; GPU Ampere+ (RTX 30xx/40xx) ưu tiên bfloat16, GPU cũ dùng float16."""
    env_dtype = str(os.getenv("OMNIVOICE_DTYPE") or "").strip().lower()
    raw = str(dtype_str if dtype_str is not None else env_dtype).strip().lower()
    dev = resolve_omnivoice_device_map(device_map).lower()
    if dev == "cpu" or dev.startswith("cpu"):
        return raw if raw in ("float32", "fp32") else "float32"
    if raw in ("bfloat16", "bf16", "float32", "fp32"):
        return raw
    if raw in ("float16", "fp16") and env_dtype in ("float16", "fp16"):
        return "float16"
    try:
        import torch

        if torch.cuda.is_available() and torch.cuda.is_bf16_supported():
            return "bfloat16"
    except Exception:
        pass
    return raw or "float16"


def _get_model(*, model_id: str, device_map: str, dtype_str: str):
    global _session_model, _session_model_key
    _ensure_cuda_and_tf32(device_map)
    try:
        import torch
        from omnivoice import OmniVoice
    except ImportError as e:
        raise RuntimeError(
            "OmniVoice: cần gói omnivoice>=0.2.1 (pip install 'omnivoice>=0.2.1'). "
            "Xem https://huggingface.co/k2-fsa/OmniVoice"
        ) from e

    mid = str(model_id or "").strip()
    if not mid:
        raise ValueError("omnivoice: model_id rỗng.")
    dev = resolve_omnivoice_device_map(device_map)
    dt = resolve_omnivoice_dtype(dtype_str, dev)
    key = (mid, dev, dt)
    if _session_model is not None and _session_model_key == key:
        return _session_model

    global _session_prompt, _session_prompt_key
    _session_prompt = None
    _session_prompt_key = None

    dtype = _resolve_dtype(dt)
    hf_token = _resolve_hf_token()
    load_kwargs = dict(
        device_map=dev,
        dtype=dtype,
    )
    if hf_token:
        # Một số bản nhận `token`, số khác nhận `use_auth_token`.
        load_kwargs["token"] = hf_token
    _apply_omnivoice_compat_patches()
    try:
        _session_model = OmniVoice.from_pretrained(
            mid,
            **load_kwargs,
        )
    except TypeError:
        if hf_token:
            load_kwargs.pop("token", None)
            load_kwargs["use_auth_token"] = hf_token
            _session_model = OmniVoice.from_pretrained(
                mid,
                **load_kwargs,
            )
        else:
            raise
    except OSError as exc:
        msg = str(exc).lower()
        if "permission denied" in msg or "os error 13" in msg:
            raise OSError(
                f"OmniVoice model download failed (Permission denied) for {mid}. "
                f"HF cache={os.environ.get('HUGGINGFACE_HUB_CACHE') or os.environ.get('HF_HOME')}. "
                "Fix: chown -R $USER tools/video-pipeline/cache "
                "and ensure HF_HUB_DISABLE_XET=1 (set by pipeline_cache)."
            ) from exc
        raise
    # Tắt KV cache của Qwen3 LLM vì OmniVoice chạy non-autoregressive (tránh cấp phát thừa ở 32 bước lặp)
    if hasattr(_session_model, "llm") and hasattr(_session_model.llm, "config"):
        _session_model.llm.config.use_cache = False
    _session_model_key = key
    return _session_model


def _resolve_voice_prompt_disk_paths(ref_path: Path, hash12: str) -> list[Path]:
    """Danh sách đường dẫn ứng viên lưu/đọc file cache `.prompt.pt` cho từng giọng."""
    filename = f"{ref_path.stem}.{hash12}.prompt.pt"
    candidates = [ref_path.parent / filename]
    try:
        cache_dir = pipeline_cache.resolve_pipeline_cache_root() / "voice_prompts"
        candidates.append(cache_dir / filename)
    except Exception:
        pass
    return candidates


def _cleanup_stale_voice_prompt_files(directory: Path, stem: str, keep_name: str) -> None:
    try:
        for old_pt in directory.glob(f"{stem}.*.prompt.pt"):
            if old_pt.name != keep_name:
                old_pt.unlink(missing_ok=True)
    except Exception:
        pass


def ensure_voice_clone_prompt(
    *,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str,
    preprocess_prompt: bool = DEFAULT_OMNIVOICE_PREPROCESS_PROMPT,
) -> Any:
    """
    Tạo / cache voice_clone_prompt từ file giọng mẫu + transcript (RAM + Disk `.prompt.pt`).
    Mỗi giọng có 1 file `.prompt.pt` riêng theo hash (path + size + mtime + ref_text + preprocess + model_id).
    """
    import hashlib

    global _session_prompt, _session_prompt_key
    ref_path = Path(ref_audio).resolve()
    if not ref_path.is_file():
        raise FileNotFoundError(f"OmniVoice: không tìm thấy ref_audio: {ref_path}")
    ra = str(ref_path)
    rt = str(ref_text or "")
    pp = bool(preprocess_prompt)
    mid = str(model_id or "k2-fsa/OmniVoice").strip()
    stat = ref_path.stat()
    mem_key = (ra, int(stat.st_size), int(stat.st_mtime_ns), rt, pp, mid)
    pk = (ra, rt, pp)

    if mem_key in _session_prompts:
        _session_prompt = _session_prompts[mem_key]
        _session_prompt_key = pk
        return _session_prompt

    hash_input = f"{ra}|{stat.st_size}|{stat.st_mtime_ns}|{rt}|{int(pp)}|{mid}".encode("utf-8")
    hash12 = hashlib.sha256(hash_input).hexdigest()[:12]
    disk_candidates = _resolve_voice_prompt_disk_paths(ref_path, hash12)

    # 1. Thử đọc từ disk cache (.prompt.pt) trước — chỉ tốn ~2ms thay vì ~3.2s encode
    for pt_path in disk_candidates:
        if pt_path.is_file() and pt_path.stat().st_size > 0:
            try:
                from omnivoice.models.omnivoice import VoiceClonePrompt

                loaded = VoiceClonePrompt.load(str(pt_path), map_location="cpu")
                _session_prompt = loaded
                _session_prompt_key = pk
                if len(_session_prompts) >= 16:
                    _session_prompts.pop(next(iter(_session_prompts)), None)
                _session_prompts[mem_key] = loaded
                return loaded
            except Exception:
                try:
                    pt_path.unlink(missing_ok=True)
                except Exception:
                    pass

    # 2. Chưa có trên disk → encode từ model và lưu `.prompt.pt` cho các lần sau
    model = _get_model(model_id=model_id, device_map=device_map, dtype_str=dtype_str)
    try:
        _session_prompt = model.create_voice_clone_prompt(
            ref_audio=ra,
            ref_text=rt,
            preprocess_prompt=pp,
        )
    except TypeError:
        # Version cũ không nhận preprocess_prompt
        _session_prompt = model.create_voice_clone_prompt(ref_audio=ra, ref_text=rt)

    if hasattr(_session_prompt, "save"):
        for pt_path in disk_candidates:
            try:
                pt_path.parent.mkdir(parents=True, exist_ok=True)
                tmp_pt = pt_path.with_suffix(".pt.tmp")
                _session_prompt.save(str(tmp_pt))
                tmp_pt.replace(pt_path)
                _cleanup_stale_voice_prompt_files(pt_path.parent, ref_path.stem, pt_path.name)
                break
            except Exception:
                continue

    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    _session_prompt_key = pk
    if len(_session_prompts) >= 16:
        _session_prompts.pop(next(iter(_session_prompts)), None)
    _session_prompts[mem_key] = _session_prompt
    return _session_prompt


def _wave_to_numpy(wave: Any) -> Any:
    """Chuyển tensor / ndarray → float32 mono 1-D."""
    import numpy as np
    import torch

    if isinstance(wave, torch.Tensor):
        wave_np = wave.detach().to(dtype=torch.float32).cpu().numpy()
    else:
        wave_np = np.asarray(wave, dtype=np.float32)
    if wave_np.ndim == 0:
        raise RuntimeError("OmniVoice: audio output rỗng/không hợp lệ (scalar).")
    if wave_np.ndim > 1:
        wave_np = wave_np.reshape(-1)
    return wave_np


def _normalize_generate_audios(audio: Any) -> list[Any]:
    """``generate()`` trả list hoặc single — luôn ra list waves."""
    if isinstance(audio, (list, tuple)):
        if not audio:
            raise RuntimeError("OmniVoice: audio output rỗng (empty list).")
        return list(audio)
    return [audio]


_OMNIVOICE_COMPAT_PATCHED = False


def _encoding_input_ids(enc: Any) -> list[int]:
    ids = enc["input_ids"] if isinstance(enc, dict) else getattr(enc, "input_ids", enc)
    if hasattr(ids, "tolist"):
        ids = ids.tolist()
    if ids and isinstance(ids[0], list):
        ids = ids[0]
    return [int(x) for x in (ids or [])]


def _clean_tokenizer_text(raw: Any) -> str:
    if raw is None:
        return ""
    if isinstance(raw, (list, tuple, dict, bytes)):
        raise TypeError(f"invalid tokenizer input type: {type(raw).__name__}")
    return sanitize_tts_unicode(str(raw))


def _tokenize_for_omnivoice(
    tokenizer: Any,
    text: str,
    *,
    add_special_tokens: bool,
    return_tensors: Optional[str] = None,
) -> Any:
    """Tokenize text for OmniVoice; prefer encode/backend for TF 5.x compatibility."""
    cleaned = _clean_tokenizer_text(text)
    if not cleaned.strip():
        if return_tensors == "pt":
            import torch

            return type("Enc", (), {"input_ids": torch.zeros((1, 0), dtype=torch.long)})()
        return []

    errors: list[str] = []
    if hasattr(tokenizer, "encode"):
        try:
            ids = tokenizer.encode(cleaned, add_special_tokens=add_special_tokens)
            if return_tensors == "pt":
                import torch

                return type("Enc", (), {"input_ids": torch.tensor([list(ids)], dtype=torch.long)})()
            return ids
        except Exception as exc:
            errors.append(f"encode: {exc}")

    backend = getattr(tokenizer, "backend_tokenizer", None) or getattr(
        tokenizer, "_tokenizer", None
    )
    if backend is not None and hasattr(backend, "encode"):
        try:
            enc = backend.encode(cleaned, add_special_tokens=add_special_tokens)
            ids = list(getattr(enc, "ids", enc))
            if return_tensors == "pt":
                import torch

                return type("Enc", (), {"input_ids": torch.tensor([ids], dtype=torch.long)})()
            return ids
        except Exception as exc:
            errors.append(f"backend.encode: {exc}")

    try:
        return tokenizer(
            cleaned,
            add_special_tokens=add_special_tokens,
            return_tensors=return_tensors,
        )
    except Exception as exc:
        errors.append(f"__call__: {exc}")
        joined = "; ".join(errors) or str(exc)
        preview = cleaned[:120].replace("\n", "\\n")
        raise TypeError(
            f"OmniVoice tokenizer failed ({joined}); preview={preview!r} len={len(cleaned)}"
        ) from exc


def _safe_tokenize_segment(tokenizer: Any, segment: str) -> list[int]:
    """Tokenize one segment between non-verbal tags."""
    text = _clean_tokenizer_text(segment)
    if not text.strip():
        return []
    for add_special in (False, True):
        try:
            out = _tokenize_for_omnivoice(
                tokenizer,
                text,
                add_special_tokens=add_special,
            )
            return _encoding_input_ids(out)
        except TypeError:
            continue
    return []


def _apply_omnivoice_compat_patches() -> None:
    """Patch upstream omnivoice tokenization for transformers 5.x."""
    global _OMNIVOICE_COMPAT_PATCHED
    if _OMNIVOICE_COMPAT_PATCHED:
        return
    try:
        import torch
        import omnivoice.models.omnivoice as ov_mod
    except ImportError:
        return

    pattern = getattr(ov_mod, "_NONVERBAL_PATTERN", None)
    if pattern is None:
        return

    def _patched_tokenize_with_nonverbal_tags(text: str, tokenizer) -> "torch.Tensor":
        text = _clean_tokenizer_text(text)
        if not text.strip():
            return torch.zeros((1, 0), dtype=torch.long)

        # Không có [laughter]/... → tokenize cả chuỗi như training processor (add_special_tokens=True).
        if pattern.search(text) is None:
            enc = _tokenize_for_omnivoice(
                tokenizer,
                text,
                add_special_tokens=True,
                return_tensors="pt",
            )
            return enc.input_ids

        parts: list[list[int]] = []
        last_end = 0
        for match in pattern.finditer(text):
            if match.start() > last_end:
                ids = _safe_tokenize_segment(tokenizer, text[last_end : match.start()])
                if ids:
                    parts.append(ids)
            ids = _safe_tokenize_segment(tokenizer, match.group())
            if ids:
                parts.append(ids)
            last_end = match.end()
        if last_end < len(text):
            ids = _safe_tokenize_segment(tokenizer, text[last_end:])
            if ids:
                parts.append(ids)

        if not parts:
            enc = _tokenize_for_omnivoice(
                tokenizer,
                text,
                add_special_tokens=True,
                return_tensors="pt",
            )
            return enc.input_ids

        combined: list[int] = []
        for chunk in parts:
            combined.extend(chunk)
        return torch.tensor([combined], dtype=torch.long)

    ov_mod._tokenize_with_nonverbal_tags = _patched_tokenize_with_nonverbal_tags

    # 1. Ưu tiên đọc model từ HF cache cục bộ trước khi gọi mạng (tiết kiệm 1-3s lúc khởi tạo)
    _orig_resolve_model_path = getattr(ov_mod, "_resolve_model_path", None)
    if callable(_orig_resolve_model_path):
        def _fast_resolve_model_path(name_or_path: str) -> str:
            if os.path.isdir(name_or_path):
                return name_or_path
            try:
                from huggingface_hub import snapshot_download

                return snapshot_download(name_or_path, local_files_only=True)
            except Exception:
                return _orig_resolve_model_path(name_or_path)

        ov_mod._resolve_model_path = _fast_resolve_model_path

    # 2. Tối ưu _generate_iterative: tắt use_cache của LLM và chỉ chiếu audio_heads trên lát cắt target (t_len)
    # thay vì chiếu toàn bộ max_c_len (gồm ~250 prompt tokens + padding), giảm ~70% tính toán audio_heads & VRAM.
    _omni_cls = getattr(ov_mod, "OmniVoice", None)
    _get_time_steps = getattr(ov_mod, "_get_time_steps", None)
    _gumbel_sample = getattr(ov_mod, "_gumbel_sample", None)
    if _omni_cls is not None and callable(_get_time_steps) and callable(_gumbel_sample):
        import math

        def _fast_generate_iterative(self, task, gen_config):
            B = task.batch_size
            inputs_list = [
                self._prepare_inference_inputs(
                    task.texts[i],
                    task.target_lens[i],
                    task.ref_texts[i],
                    task.ref_audio_tokens[i],
                    task.langs[i],
                    task.instructs[i],
                    gen_config.denoise,
                )
                for i in range(B)
            ]
            c_lens = [inp["input_ids"].size(2) for inp in inputs_list]
            max_c_len = max(c_lens)
            pad_id = self.config.audio_mask_id
            num_cb = self.config.num_audio_codebook
            vocab_sz = self.config.audio_vocab_size

            batch_input_ids = torch.full(
                (2 * B, num_cb, max_c_len),
                pad_id,
                dtype=torch.long,
                device=self.device,
            )
            batch_audio_mask = torch.zeros(
                (2 * B, max_c_len), dtype=torch.bool, device=self.device
            )
            batch_attention_mask = torch.zeros(
                (2 * B, 1, max_c_len, max_c_len), dtype=torch.bool, device=self.device
            )

            for i, inp in enumerate(inputs_list):
                c_len, u_len = c_lens[i], task.target_lens[i]
                batch_input_ids[i, :, :c_len] = inp["input_ids"]
                batch_audio_mask[i, :c_len] = inp["audio_mask"]
                batch_attention_mask[i, :, :c_len, :c_len] = True

                batch_input_ids[B + i, :, :u_len] = inp["input_ids"][..., -u_len:]
                batch_audio_mask[B + i, :u_len] = inp["audio_mask"][..., -u_len:]
                batch_attention_mask[B + i, :, :u_len, :u_len] = True
                if max_c_len > u_len:
                    pad_diag = torch.arange(u_len, max_c_len, device=self.device)
                    batch_attention_mask[B + i, :, pad_diag, pad_diag] = True

            tokens = torch.full(
                (B, num_cb, max(task.target_lens)),
                pad_id,
                dtype=torch.long,
                device=self.device,
            )

            timesteps = _get_time_steps(
                t_start=0.0,
                t_end=1.0,
                num_step=gen_config.num_step,
                t_shift=gen_config.t_shift,
            ).tolist()
            schedules = []
            for t_len in task.target_lens:
                total_mask = t_len * num_cb
                rem = total_mask
                sched = []
                for step in range(gen_config.num_step):
                    num = (
                        rem
                        if step == gen_config.num_step - 1
                        else min(
                            math.ceil(total_mask * (timesteps[step + 1] - timesteps[step])),
                            rem,
                        )
                    )
                    sched.append(int(num))
                    rem -= int(num)
                schedules.append(sched)

            layer_ids = torch.arange(num_cb, device=self.device).view(1, -1, 1)

            for step in range(gen_config.num_step):
                inputs_embeds = self._prepare_embed_inputs(batch_input_ids, batch_audio_mask)
                llm_outputs = self.llm(
                    inputs_embeds=inputs_embeds,
                    attention_mask=batch_attention_mask,
                    return_dict=True,
                    use_cache=False,
                )
                hidden_states = llm_outputs[0]

                for i in range(B):
                    k = schedules[i][step]
                    if k <= 0:
                        continue
                    c_len, t_len = c_lens[i], task.target_lens[i]
                    c_h = hidden_states[i : i + 1, c_len - t_len : c_len, :]
                    u_h = hidden_states[B + i : B + i + 1, :t_len, :]
                    pair_h = torch.cat([c_h, u_h], dim=0)
                    pair_logits = (
                        self.audio_heads(pair_h)
                        .view(2, t_len, num_cb, vocab_sz)
                        .permute(0, 2, 1, 3)
                        .to(torch.float32)
                    )
                    c_logits = pair_logits[0:1]
                    u_logits = pair_logits[1:2]

                    pred_tokens, scores = self._predict_tokens_with_scoring(
                        c_logits, u_logits, gen_config
                    )
                    scores = scores - (layer_ids * gen_config.layer_penalty_factor)
                    if gen_config.position_temperature > 0.0:
                        scores = _gumbel_sample(scores, gen_config.position_temperature)

                    sample_tokens = tokens[i : i + 1, :, :t_len]
                    scores.masked_fill_(sample_tokens != pad_id, -float("inf"))

                    _, topk_idx = torch.topk(scores.flatten(), k)
                    flat_tokens = sample_tokens.flatten()
                    flat_tokens[topk_idx] = pred_tokens.flatten()[topk_idx]
                    sample_tokens.copy_(flat_tokens.view_as(sample_tokens))

                    tokens[i : i + 1, :, :t_len] = sample_tokens
                    batch_input_ids[i : i + 1, :, c_len - t_len : c_len] = sample_tokens
                    batch_input_ids[B + i : B + i + 1, :, :t_len] = sample_tokens

            return [tokens[i, :, : task.target_lens[i]] for i in range(B)]

        _omni_cls._generate_iterative = _fast_generate_iterative

    _OMNIVOICE_COMPAT_PATCHED = True


def _run_omnivoice_generate(
    model: Any,
    texts: Sequence[str],
    *,
    voice_prompt: Any,
    language: str,
    ref_audio_path: str,
    ref_text: str,
    denoise: bool,
    preprocess_prompt: bool,
    postprocess_output: bool,
    num_step: Optional[int],
    guidance_scale: Optional[float],
) -> list[Any]:
    """Gọi ``model.generate`` cho 1 hoặc nhiều text; trả list wave (pre-numpy)."""
    _apply_omnivoice_compat_patches()

    from omnivoice import OmniVoiceGenerationConfig

    text_list = [str(t) for t in texts]
    if not text_list:
        return []

    pp = bool(preprocess_prompt)
    langs = [language] * len(text_list)
    resolved_steps = resolve_omnivoice_num_step(num_step)
    resolved_cfg = resolve_omnivoice_guidance_scale(guidance_scale)
    gen_config = OmniVoiceGenerationConfig(
        num_step=resolved_steps,
        guidance_scale=resolved_cfg,
        denoise=bool(denoise),
        preprocess_prompt=pp,
        postprocess_output=bool(postprocess_output),
    )

    vcp = voice_prompt
    if len(text_list) > 1 and not isinstance(vcp, list):
        vcp = [voice_prompt] * len(text_list)

    gen_text: str | list[str] = text_list[0] if len(text_list) == 1 else text_list
    gen_lang: str | list[str] = langs[0] if len(text_list) == 1 else langs

    audio = model.generate(
        text=gen_text,
        voice_clone_prompt=vcp,
        language=gen_lang,
        generation_config=gen_config,
    )
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    waves = _normalize_generate_audios(audio)
    if len(waves) != len(text_list):
        raise RuntimeError(
            f"OmniVoice: batch output count {len(waves)} != input {len(text_list)}"
        )
    return waves


def _write_waves_to_files(waves: Sequence[Any], out_wavs: Sequence[str | Path]) -> None:
    import soundfile as sf

    if len(waves) != len(out_wavs):
        raise ValueError("OmniVoice: waves/out_wavs length mismatch")
    for wave, out_wav in zip(waves, out_wavs):
        out = Path(out_wav)
        out.parent.mkdir(parents=True, exist_ok=True)
        wave_np = _wave_to_numpy(wave)
        sf.write(str(out), wave_np, 24000)


def _prepare_synthesis_context(
    *,
    texts: Sequence[str],
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str,
    language: str | None,
    preprocess_prompt: bool,
    normalize_text: bool,
    seed: Optional[int],
) -> tuple[Any, str, str, list[str], Any]:
    import torch

    if not texts:
        raise ValueError("OmniVoice: texts rỗng.")

    model = _get_model(model_id=model_id, device_map=device_map, dtype_str=dtype_str)
    ref_audio_path = str(Path(ref_audio).resolve())
    if not Path(ref_audio_path).is_file():
        raise FileNotFoundError(f"OmniVoice: không tìm thấy ref_audio: {ref_audio_path}")

    resolved_language = resolve_omnivoice_language(language)
    vinorm = bool(normalize_text)
    prepared: list[str] = []
    for text in texts:
        t = prepare_omnivoice_input_text(
            text,
            resolved_language,
            vinorm_enabled=vinorm,
        )
        if not t:
            raise ValueError("OmniVoice: text rỗng sau chuẩn hóa.")
        prepared.append(t)

    rt = sanitize_tts_unicode(str(ref_text or "").strip())
    pp = bool(preprocess_prompt)
    voice_prompt = ensure_voice_clone_prompt(
        ref_audio=ref_audio_path,
        ref_text=rt,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        preprocess_prompt=pp,
    )

    if seed is not None:
        torch.manual_seed(int(seed))
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(int(seed))

    return model, ref_audio_path, rt, prepared, voice_prompt


def synthesize_batch_to_wavs(
    *,
    texts: Sequence[str],
    out_wavs: Sequence[str | Path],
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str = "auto",
    language: str | None = None,
    num_step: Optional[int] = None,
    guidance_scale: Optional[float] = None,
    denoise: bool = DEFAULT_OMNIVOICE_DENOISE,
    preprocess_prompt: bool = DEFAULT_OMNIVOICE_PREPROCESS_PROMPT,
    postprocess_output: bool = DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT,
    normalize_text: bool = False,
    seed: Optional[int] = None,
) -> None:
    """
    Sinh nhiều đoạn thoại trong một ``model.generate()`` (batch inference).
    Dùng cached model + voice_clone_prompt (cùng ref cho mọi item).
    """
    try:
        import soundfile as sf  # noqa: F401 — dependency check
    except ImportError as e:
        raise RuntimeError(
            "OmniVoice: cần torch + soundfile để lưu WAV (pip install soundfile)."
        ) from e

    text_list = [str(t or "") for t in texts]
    out_list = list(out_wavs)
    if not text_list:
        return
    if len(text_list) != len(out_list):
        raise ValueError("OmniVoice: texts và out_wavs phải cùng độ dài.")

    resolved_language = resolve_omnivoice_language(language)
    model, ref_audio_path, rt, prepared, voice_prompt = _prepare_synthesis_context(
        texts=text_list,
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        language=resolved_language,
        preprocess_prompt=preprocess_prompt,
        normalize_text=normalize_text,
        seed=seed,
    )

    waves = _run_omnivoice_generate(
        model,
        prepared,
        voice_prompt=voice_prompt,
        language=resolved_language,
        ref_audio_path=ref_audio_path,
        ref_text=rt,
        denoise=denoise,
        preprocess_prompt=preprocess_prompt,
        postprocess_output=postprocess_output,
        num_step=num_step,
        guidance_scale=guidance_scale,
    )
    _write_waves_to_files(waves, out_list)


def synthesize_many_to_wavs(
    items: Sequence[dict[str, Any]],
    *,
    batch_size: Optional[int] = None,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str = "auto",
    language: str | None = None,
    num_step: Optional[int] = None,
    guidance_scale: Optional[float] = None,
    denoise: bool = DEFAULT_OMNIVOICE_DENOISE,
    preprocess_prompt: bool = DEFAULT_OMNIVOICE_PREPROCESS_PROMPT,
    postprocess_output: bool = DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT,
    normalize_text: bool = False,
    seed: Optional[int] = None,
    fallback_sequential: bool = True,
) -> None:
    """
    Chia ``items`` (mỗi phần tử có ``text``, ``out_wav``) thành batch (đã sắp xếp theo độ dài text
    để giảm padding trên GPU) và gọi ``synthesize_batch_to_wavs``.
    Batch lỗi → fallback tuần tự nếu ``fallback_sequential``.
    """
    if not items:
        return

    bs = resolve_omnivoice_batch_size(batch_size)
    shared_kw = dict(
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        language=language,
        num_step=num_step,
        guidance_scale=guidance_scale,
        denoise=denoise,
        preprocess_prompt=preprocess_prompt,
        postprocess_output=postprocess_output,
        normalize_text=normalize_text,
        seed=seed,
    )

    # Length-sorted batching: gom các câu có độ dài tương đương vào cùng 1 batch để giảm padding
    sorted_items = (
        sorted(items, key=lambda x: len(str(x.get("text") or "")))
        if bs > 1 and len(items) > 1
        else list(items)
    )

    chunk: list[dict[str, Any]] = []
    for item in sorted_items:
        chunk.append(item)
        if len(chunk) >= bs:
            _synthesize_many_chunk(chunk, shared_kw=shared_kw, fallback_sequential=fallback_sequential)
            chunk = []
    if chunk:
        _synthesize_many_chunk(chunk, shared_kw=shared_kw, fallback_sequential=fallback_sequential)


def _synthesize_many_chunk(
    chunk: list[dict[str, Any]],
    *,
    shared_kw: dict[str, Any],
    fallback_sequential: bool,
) -> None:
    texts = [str(item.get("text") or "") for item in chunk]
    out_wavs = [item.get("out_wav") for item in chunk]
    if any(not str(t).strip() for t in texts):
        raise ValueError("OmniVoice: item thiếu text trong batch.")
    if any(not w for w in out_wavs):
        raise ValueError("OmniVoice: item thiếu out_wav trong batch.")

    try:
        synthesize_batch_to_wavs(
            texts=texts,
            out_wavs=out_wavs,
            **shared_kw,
        )
    except Exception as batch_exc:
        if not fallback_sequential or len(chunk) <= 1:
            raise
        for item in chunk:
            try:
                synthesize_to_wav(
                    text=str(item.get("text") or ""),
                    out_wav=item.get("out_wav"),
                    **shared_kw,
                )
            except Exception:
                raise batch_exc


def synthesize_to_wav(
    *,
    text: str,
    out_wav: str | Path,
    ref_audio: str | Path,
    ref_text: str,
    model_id: str,
    device_map: str,
    dtype_str: str = "auto",
    language: str | None = None,
    num_step: Optional[int] = None,
    guidance_scale: Optional[float] = None,
    denoise: bool = DEFAULT_OMNIVOICE_DENOISE,
    preprocess_prompt: bool = DEFAULT_OMNIVOICE_PREPROCESS_PROMPT,
    postprocess_output: bool = DEFAULT_OMNIVOICE_POSTPROCESS_OUTPUT,
    normalize_text: bool = False,
    seed: Optional[int] = None,
) -> None:
    """
    Sinh một đoạn thoại, ghi WAV mono 24 kHz (theo model card).
    Dùng cached model + voice prompt khi ref_audio/ref_text/model không đổi.
    
    ✨ QUAN TRỌNG: Sử dụng cached voice_clone_prompt để đảm bảo tone giọng ổn định giữa các câu.
    
    Args:
        text: Nội dung cần tổng hợp giọng nói
        out_wav: Đường dẫn file WAV output
        ref_audio: File audio mẫu để clone giọng (sẽ được cache)
        ref_text: Transcript của audio mẫu (sẽ được cache cùng ref_audio)
        model_id: HuggingFace model ID
        device_map: Device để chạy model (cuda:0, cpu, etc.)
        dtype_str: Data type (float16, bfloat16, float32)
        language: Ngôn ngữ bắt buộc — vietnamese | english | korean | japanese
        num_step: Inference steps (upstream default 32)
        guidance_scale: CFG scale (upstream default 2.0)
        denoise: Bật token ``<|denoise|>`` (upstream default True)
        preprocess_prompt: Preprocess ref audio/text khi tạo clone prompt
        postprocess_output: Trim silence / fade / pad output
        normalize_text: Bật vinorm + acronym rules (``OMNIVOICE_NORMALIZE_TEXT``)
        seed: Random seed để tạo output deterministic (giúp tái tạo chính xác cùng output)
    """
    synthesize_batch_to_wavs(
        texts=[text],
        out_wavs=[out_wav],
        ref_audio=ref_audio,
        ref_text=ref_text,
        model_id=model_id,
        device_map=device_map,
        dtype_str=dtype_str,
        language=language,
        num_step=num_step,
        guidance_scale=guidance_scale,
        denoise=denoise,
        preprocess_prompt=preprocess_prompt,
        postprocess_output=postprocess_output,
        normalize_text=normalize_text,
        seed=seed,
    )
