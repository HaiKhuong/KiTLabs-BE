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
_SESSION_KEY: tuple[str, str, str, str] | None = None


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
        raise ValueError("vieneu: PyTorch backend is not supported for CPU; use ONNX")
    return value


def get_vieneu_session(
    *,
    model_id: str = DEFAULT_MODEL_ID,
    codec_id: str = DEFAULT_CODEC_ID,
    device: str = "auto",
    backend: str = "auto",
) -> Any:
    global _SESSION, _SESSION_KEY

    resolved_device = _resolve_device(device)
    resolved_backend = _resolve_backend(backend, resolved_device)
    key = (model_id or DEFAULT_MODEL_ID, codec_id or DEFAULT_CODEC_ID, resolved_device, resolved_backend)
    if _SESSION is not None and _SESSION_KEY == key:
        return _SESSION

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
        )
    except Exception as exc:
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

    if seed is not None:
        np.random.seed(int(seed))
        try:
            import torch

            torch.manual_seed(int(seed))
        except ImportError:
            pass

    tts = get_vieneu_session(
        model_id=model_id,
        codec_id=codec_id,
        device=device,
        backend=backend,
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
    **kwargs: Any,
) -> list[str]:
    # Keep the public adapter stable first; the cached session avoids model reloads.
    # Native infer_batch can be enabled after GPU compatibility is verified on TF 5.x.
    outputs: list[str] = []
    for job in jobs:
        outputs.append(
            synthesize_to_wav(
                text=str(job.get("text") or ""),
                out_wav=job["out_wav"],
                **kwargs,
            )
        )
    return outputs
