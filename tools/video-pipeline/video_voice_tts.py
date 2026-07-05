"""
Video workflow — TTS từng scene bằng omnivoice_tts (giống auto_vietsub Step3).

Stdin JSON:
  ref_audio, ref_text, model_id?, device_map?, dtype_str?, language?, num_step?, guidance_scale?, seed?,
  scenes: [{ sceneNumber, text, out_wav }]

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
from omnivoice_tts import synthesize_to_wav


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
    language = str(payload.get("language") or os.getenv("OMNIVOICE_LANGUAGE") or "vietnamese").strip() or "vietnamese"
    num_step = int(payload.get("num_step") or os.getenv("OMNIVOICE_NUM_STEP") or 8)
    guidance_scale = float(payload.get("guidance_scale") or os.getenv("OMNIVOICE_GUIDANCE_SCALE") or 2)
    seed = _resolve_seed(payload.get("seed"))

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
        seed=seed,
    )

    results: list[dict[str, Any]] = []
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
        try:
            synthesize_to_wav(text=text, out_wav=str(out_path), **omnivoice_kw)
            if not out_path.is_file() or out_path.stat().st_size <= 0:
                raise RuntimeError(f"empty output: {out_path}")
            results.append({"sceneNumber": scene_number, "ok": True})
        except Exception as exc:
            results.append({"sceneNumber": scene_number, "ok": False, "error": str(exc) or exc.__class__.__name__})

    json.dump({"segments": results}, sys.stdout, ensure_ascii=False)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
