"""
ShortVideo — sync timeline to voice.

TTS each caption in a SINGLE process (model loaded once), measure the real audio
duration per caption, concat everything into one voice WAV, and return the actual
timeline (start/end per caption) so the video can align subtitles/scenes to the
generated speech.

Stdin JSON:
  engine?: omnivoice | voxcpm2 (default omnivoice)
  captions: [str] | [{ text }]     # in order
  out_wav: str
  ref_audio, ref_text, language
  model_id?, device_map?, dtype_str?, num_step?, guidance_scale?   (omnivoice)
  cfg_value?, inference_timesteps?                                 (voxcpm2)
  seed?, playback_speed?, gap_sec?, sample_rate?

Stdout JSON:
  { ok, out_wav, total_sec, segments: [{ index, start, end, duration }] }
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable

import pipeline_cache  # noqa: F401 — route HF cache to tools/video-pipeline/cache
from audio_srt_timeline_tts import (
    _apply_speed,
    _concat_wavs,
    _probe_duration_sec,
    _write_silence,
)

SAMPLE_RATE = 24000
DEFAULT_GAP_SEC = 0.12


def _build_engine(payload: dict[str, Any]) -> tuple[Callable[[str], str], Callable[[str, Path], None]]:
    ref_audio = Path(str(payload["ref_audio"])).expanduser()
    if not ref_audio.is_file():
        raise FileNotFoundError(f"ref_audio not found: {ref_audio}")
    ref_text = str(payload.get("ref_text") or "")
    seed = payload.get("seed")
    engine_key = str(payload.get("engine") or "omnivoice").strip().lower()

    if engine_key == "voxcpm2":
        from voxcpm2_tts import (
            prepare_voxcpm2_input_text,
            resolve_voxcpm2_language,
            synthesize_to_wav as synth,
        )

        language = resolve_voxcpm2_language(str(payload.get("language") or "vietnamese"))
        model_id = str(payload.get("model_id") or "openbmb/VoxCPM2").strip()
        cfg_value = float(
            payload.get("cfg_value") if payload.get("cfg_value") not in (None, "") else 2.0
        )
        inference_timesteps = int(
            payload.get("inference_timesteps")
            if payload.get("inference_timesteps") not in (None, "")
            else 10
        )

        def prepare(raw: str) -> str:
            return prepare_voxcpm2_input_text(raw, language)

        def synthesize(text: str, out_wav: Path) -> None:
            synth(
                text=text,
                out_wav=out_wav,
                ref_audio=str(ref_audio),
                ref_text=ref_text,
                model_id=model_id,
                language=language,
                cfg_value=cfg_value,
                inference_timesteps=inference_timesteps,
                seed=int(seed) if seed not in (None, "") else None,
            )

        return prepare, synthesize

    from omnivoice_tts import (
        prepare_omnivoice_input_text,
        resolve_omnivoice_language,
        synthesize_to_wav as synth,
    )

    language = resolve_omnivoice_language(str(payload.get("language") or "vietnamese"))
    model_id = str(payload.get("model_id") or "k2-fsa/OmniVoice").strip()
    device_map = str(payload.get("device_map") or "cpu").strip() or "cpu"
    dtype_str = str(payload.get("dtype_str") or "float16").strip() or "float16"
    num_step = payload.get("num_step")
    guidance_scale = payload.get("guidance_scale")

    def prepare(raw: str) -> str:
        return prepare_omnivoice_input_text(raw)

    def synthesize(text: str, out_wav: Path) -> None:
        synth(
            text=text,
            out_wav=out_wav,
            ref_audio=str(ref_audio),
            ref_text=ref_text,
            model_id=model_id,
            device_map=device_map,
            dtype_str=dtype_str,
            language=language,
            num_step=int(num_step) if num_step not in (None, "") else None,
            guidance_scale=float(guidance_scale) if guidance_scale not in (None, "") else None,
            seed=int(seed) if seed not in (None, "") else None,
        )

    return prepare, synthesize


def _extract_texts(payload: dict[str, Any]) -> list[str]:
    raw = payload.get("captions")
    texts: list[str] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str):
                text = item.strip()
            elif isinstance(item, dict):
                text = str(item.get("text") or "").strip()
            else:
                text = ""
            if text:
                texts.append(text)
    return texts


def run(payload: dict[str, Any]) -> dict[str, Any]:
    out_wav = Path(str(payload["out_wav"]))
    out_wav.parent.mkdir(parents=True, exist_ok=True)
    sample_rate = int(payload.get("sample_rate") or SAMPLE_RATE)
    playback_speed = max(
        0.5, min(2.0, float(payload.get("playback_speed") or payload.get("speed") or 1.0))
    )
    gap_sec = payload.get("gap_sec")
    gap_sec = DEFAULT_GAP_SEC if gap_sec in (None, "") else max(0.0, float(gap_sec))

    texts = _extract_texts(payload)
    if not texts:
        raise ValueError("captions must contain at least one non-empty text")

    prepare, synthesize = _build_engine(payload)

    segments: list[dict[str, Any]] = []
    timeline_parts: list[Path] = []
    cursor = 0.0

    with tempfile.TemporaryDirectory(prefix="sv_voice_") as tmp:
        tmp_dir = Path(tmp)
        for i, raw_text in enumerate(texts):
            text = prepare(raw_text)
            raw_path = tmp_dir / f"raw_{i:04d}.wav"
            synthesize(text, raw_path)

            seg_path = tmp_dir / f"seg_{i:04d}.wav"
            _apply_speed(raw_path, seg_path, playback_speed)

            dur = _probe_duration_sec(seg_path)
            if dur <= 0.0:
                dur = 0.05

            start = cursor
            end = cursor + dur
            segments.append(
                {
                    "index": i,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "duration": round(dur, 3),
                }
            )
            timeline_parts.append(seg_path)
            cursor = end

            if gap_sec > 0.0 and i < len(texts) - 1:
                gap_path = tmp_dir / f"gap_{i:04d}.wav"
                _write_silence(gap_path, gap_sec, sample_rate)
                timeline_parts.append(gap_path)
                cursor += gap_sec

        _concat_wavs(timeline_parts, out_wav)

    total = _probe_duration_sec(out_wav) or cursor
    return {
        "ok": True,
        "out_wav": str(out_wav.resolve()),
        "total_sec": round(total, 3),
        "segments": segments,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict):
            raise ValueError("stdin must be a JSON object")
        print(json.dumps(run(payload), ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 — surface message to the Node caller
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
