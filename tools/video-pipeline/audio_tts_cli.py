#!/usr/bin/env python3
"""CLI wrapper for omnivoice_tts — used by KiTLabs BE audio API."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def _resolve_device_map(raw: str) -> str:
    s = str(raw or "").strip()
    if s:
        return s
    try:
        import torch

        return "cuda:0" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def main() -> int:
    parser = argparse.ArgumentParser(description="OmniVoice TTS CLI")
    parser.add_argument("--text", required=True, help="Text to synthesize")
    parser.add_argument("--out", required=True, help="Output WAV path")
    parser.add_argument("--ref-audio", required=True, help="Reference audio for voice clone")
    parser.add_argument("--ref-text", default="", help="Transcript of reference audio")
    parser.add_argument("--model-id", default="", help="HuggingFace model id")
    parser.add_argument("--device-map", default="", help="cuda:0 | cpu")
    parser.add_argument("--dtype", default="float16", help="float16 | bfloat16 | float32")
    parser.add_argument("--language", default="vietnamese", help="e.g. vietnamese")
    parser.add_argument("--num-step", type=int, default=8)
    parser.add_argument("--guidance-scale", type=float, default=2.0)
    parser.add_argument("--seed", type=int, default=None)
    args = parser.parse_args()

    model_id = str(args.model_id or os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")).strip()
    if not model_id:
        print(json.dumps({"ok": False, "error": "model_id is empty"}), file=sys.stderr)
        return 1

    ref_audio = str(Path(args.ref_audio).resolve())
    if not Path(ref_audio).is_file():
        print(json.dumps({"ok": False, "error": f"ref_audio not found: {ref_audio}"}), file=sys.stderr)
        return 1

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    from omnivoice_tts import synthesize_to_wav

    synthesize_to_wav(
        text=str(args.text or ""),
        out_wav=str(out_path),
        ref_audio=ref_audio,
        ref_text=str(args.ref_text or ""),
        model_id=model_id,
        device_map=_resolve_device_map(str(args.device_map or "")),
        dtype_str=str(args.dtype or "float16"),
        language=str(args.language or "vietnamese"),
        num_step=int(args.num_step) if args.num_step is not None else 8,
        guidance_scale=float(args.guidance_scale) if args.guidance_scale is not None else 2.0,
        seed=int(args.seed) if args.seed is not None else None,
    )

    print(json.dumps({"ok": True, "out": str(out_path.resolve())}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
