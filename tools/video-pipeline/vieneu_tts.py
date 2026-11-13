"""VieNeu-TTS v3 Turbo adapter shared by KiTLabs audio pipelines.

VieNeu is intentionally loaded lazily. CPU uses the upstream ONNX backend while
CUDA uses the PyTorch backend in the same environment as OmniVoice/VoxCPM2.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable, Optional

import numpy as np
import soundfile as sf

import pipeline_cache  # noqa: F401 - configure the shared Hugging Face cache first

DEFAULT_MODEL_ID = "pnnbao-ump/VieNeu-TTS-v3-Turbo"
DEFAULT_CODEC_ID = "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano"
SAMPLE_RATE = 48_000

_SESSION: Any = None
_SESSION_KEY: tuple[str, str, str, str, str] | None = None


def reset_vieneu_session() -> None:
    global _SESSION, _SESSION_KEY
    _SESSION = None
    _SESSION_KEY = None
    try:
        import gc
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def prepare_vieneu_input_text(text: str) -> str:
    return str(text or "").strip()


def _resolve_device(raw: str | None) -> str:
    value = str(raw or os.getenv("VIENEU_DEVICE") or "auto").strip().lower()
    return value or "auto"


def _resolve_backend(raw: str | None, device: str) -> str:
    value = str(raw or os.getenv("VIENEU_BACKEND") or "auto").strip().lower()
    if value not in {"auto", "onnx", "pytorch"}:
        raise ValueError(f"vieneu: invalid backend {value!r}; expected auto, onnx or pytorch")
    if value == "pytorch" and device == "cpu":
        return "onnx"
    return value


def _resolve_precision(raw: str | None = None) -> str:
    value = str(raw or os.getenv("VIENEU_PRECISION") or "int8").strip().lower()
    if value not in {"int8", "fp32"}:
        return "int8"
    return value


def _ensure_cuda_dlls_if_needed(device: str, backend: str) -> None:
    if backend == "onnx" or device == "cpu":
        return
    try:
        from cuda_dlls import ensure_windows_cuda_dlls

        ensure_windows_cuda_dlls()
    except Exception:
        pass


def get_vieneu_session(
    *,
    model_id: str = DEFAULT_MODEL_ID,
    codec_id: str = DEFAULT_CODEC_ID,
    device: str = "auto",
    backend: str = "auto",
    precision: str | None = None,
) -> Any:
    global _SESSION, _SESSION_KEY

    resolved_device = _resolve_device(device)
    resolved_backend = _resolve_backend(backend, resolved_device)
    resolved_precision = _resolve_precision(precision)
    key = (
        model_id or DEFAULT_MODEL_ID,
        codec_id or DEFAULT_CODEC_ID,
        resolved_device,
        resolved_backend,
        resolved_precision,
    )
    if _SESSION is not None and _SESSION_KEY == key:
        return _SESSION

    _ensure_cuda_dlls_if_needed(resolved_device, resolved_backend)

    try:
        from vieneu import Vieneu
    except ImportError as exc:
        raise RuntimeError(
            'VieNeu is not installed. Install "vieneu>=3.8.3" from Settings > Environment.'
        ) from exc

    try:
        _SESSION = Vieneu(
            mode="v3turbo",
            backbone_repo=key[0],
            moss_tokenizer=key[1],
            device=resolved_device,
            backend=resolved_backend,
            precision=resolved_precision,
        )
    except Exception as exc:
        if resolved_backend != "onnx":
            # Safe fallback to CPU ONNX INT8 if GPU / Transformers runtime fails
            try:
                _SESSION = Vieneu(
                    mode="v3turbo",
                    backbone_repo=key[0],
                    moss_tokenizer=key[1],
                    device="cpu",
                    backend="onnx",
                    precision=resolved_precision,
                )
                _SESSION_KEY = key
                return _SESSION
            except Exception:
                pass
        message = str(exc)
        if "transformers" in message.lower() or "qwen3" in message.lower():
            raise RuntimeError(
                "VieNeu is incompatible with the installed Transformers runtime. "
                "Keep transformers>=5.3 and update the VieNeu compatibility adapter. "
                f"Original error: {message}"
            ) from exc
        raise

    _SESSION_KEY = key
    return _SESSION


def reset_vieneu_session() -> None:
    global _SESSION, _SESSION_KEY
    _SESSION = None
    _SESSION_KEY = None


def _apply_seed(seed: Optional[int]) -> None:
    if seed is None:
        return
    np.random.seed(int(seed))
    try:
        import torch

        torch.manual_seed(int(seed))
    except ImportError:
        pass


def synthesize_to_wav(
    *,
    text: str,
    out_wav: str | Path,
    ref_audio: str | Path | None = None,
    voice: str | None = None,
    model_id: str = DEFAULT_MODEL_ID,
    codec_id: str = DEFAULT_CODEC_ID,
    device: str = "auto",
    backend: str = "auto",
    precision: str | None = None,
    temperature: float = 0.8,
    top_k: int = 25,
    top_p: float = 0.95,
    repetition_penalty: float = 1.2,
    max_new_frames: int = 300,
    max_chars: int = 256,
    denoise: bool = True,
    seed: Optional[int] = None,
    **_: Any,
) -> str:
    cleaned = prepare_vieneu_input_text(text)
    if not cleaned:
        raise ValueError("vieneu: text is empty")
    ref_path = str(Path(ref_audio).resolve()) if ref_audio else None
    if ref_path and not Path(ref_path).is_file():
        raise FileNotFoundError(f"vieneu: reference audio not found: {ref_path}")

    _apply_seed(seed)

    tts = get_vieneu_session(
        model_id=model_id,
        codec_id=codec_id,
        device=device,
        backend=backend,
        precision=precision,
    )
    wav = tts.infer(
        cleaned,
        ref_audio=ref_path,
        voice=None if ref_path else (voice or None),
        denoise=bool(denoise),
        temperature=float(temperature),
        top_k=int(top_k),
        top_p=float(top_p),
        repetition_penalty=float(repetition_penalty),
        max_new_frames=int(max_new_frames),
        max_chars=int(max_chars),
        apply_watermark=False,
        show_progress=False,
    )
    audio = np.asarray(wav, dtype=np.float32)
    if audio.size == 0:
        raise RuntimeError("vieneu: synthesis returned empty audio")
    output = Path(out_wav)
    output.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output), audio, int(getattr(tts, "sample_rate", SAMPLE_RATE)))
    return str(output.resolve())


def synthesize_many_to_wavs(
    jobs: Iterable[dict[str, Any]],
    *,
    batch_size: int = 8,
    ref_audio: str | Path | None = None,
    voice: str | None = None,
    model_id: str = DEFAULT_MODEL_ID,
    codec_id: str = DEFAULT_CODEC_ID,
    device: str = "auto",
    backend: str = "auto",
    precision: str | None = None,
    temperature: float = 0.8,
    top_k: int = 25,
    top_p: float = 0.95,
    repetition_penalty: float = 1.2,
    max_new_frames: int = 300,
    max_chars: int = 256,
    denoise: bool = True,
    seed: Optional[int] = None,
    **kwargs: Any,
) -> list[str]:
    job_list = list(jobs)
    if not job_list:
        return []

    common_kw = dict(
        ref_audio=ref_audio,
        voice=voice,
        model_id=model_id,
        codec_id=codec_id,
        device=device,
        backend=backend,
        precision=precision,
        temperature=temperature,
        top_k=top_k,
        top_p=top_p,
        repetition_penalty=repetition_penalty,
        max_new_frames=max_new_frames,
        max_chars=max_chars,
        denoise=denoise,
        seed=seed,
        **kwargs,
    )

    if len(job_list) == 1 or int(batch_size) <= 1:
        return [
            synthesize_to_wav(
                text=str(job.get("text") or ""),
                out_wav=job["out_wav"],
                **common_kw,
            )
            for job in job_list
        ]

    texts = [prepare_vieneu_input_text(str(job.get("text") or "")) for job in job_list]
    if any(not t for t in texts):
        raise ValueError("vieneu: one or more batch texts are empty")

    ref_path = str(Path(ref_audio).resolve()) if ref_audio else None
    if ref_path and not Path(ref_path).is_file():
        raise FileNotFoundError(f"vieneu: reference audio not found: {ref_path}")

    _apply_seed(seed)

    tts = get_vieneu_session(
        model_id=model_id,
        codec_id=codec_id,
        device=device,
        backend=backend,
        precision=precision,
    )

    infer_batch_fn = getattr(tts, "infer_batch", None)
    if callable(infer_batch_fn):
        try:
            wavs = infer_batch_fn(
                texts,
                ref_audio=ref_path,
                voice=None if ref_path else (voice or None),
                denoise=bool(denoise),
                temperature=float(temperature),
                top_k=int(top_k),
                top_p=float(top_p),
                repetition_penalty=float(repetition_penalty),
                max_new_frames=int(max_new_frames),
                max_chars=int(max_chars),
                apply_watermark=False,
                batch_size=max(1, int(batch_size)),
                show_progress=False,
            )
            if isinstance(wavs, list) and len(wavs) == len(job_list):
                sr = int(getattr(tts, "sample_rate", SAMPLE_RATE))
                outputs: list[str] = []
                for job, wav in zip(job_list, wavs):
                    audio = np.asarray(wav, dtype=np.float32)
                    if audio.size == 0:
                        return [
                            synthesize_to_wav(
                                text=str(j.get("text") or ""),
                                out_wav=j["out_wav"],
                                **common_kw,
                            )
                            for j in job_list
                        ]
                    output = Path(job["out_wav"])
                    output.parent.mkdir(parents=True, exist_ok=True)
                    sf.write(str(output), audio, sr)
                    outputs.append(str(output.resolve()))
                return outputs
        except Exception:
            pass

    return [
        synthesize_to_wav(
            text=str(job.get("text") or ""),
            out_wav=job["out_wav"],
            **common_kw,
        )
        for job in job_list
    ]
