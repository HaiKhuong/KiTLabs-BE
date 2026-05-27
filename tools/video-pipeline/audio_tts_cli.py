#!/usr/bin/env python3
"""CLI wrapper for omnivoice_tts — used when AUDIO_OMNIVOICE_DAEMON=false or fallback."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time

from audio_tts_worker import run_synthesis

logging.basicConfig(
    level=logging.INFO,
    format="[omnivoice-cli] %(message)s",
    stream=sys.stderr,
    force=True,
)
log = logging.getLogger("omnivoice-cli")


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

    log.info("start text_len=%s out=%s", len(str(args.text or "")), args.out)
    t0 = time.perf_counter()
    try:
        out_path = run_synthesis(
            text=str(args.text or ""),
            out=str(args.out),
            ref_audio=str(args.ref_audio),
            ref_text=str(args.ref_text or ""),
            model_id=str(args.model_id or os.getenv("OMNIVOICE_MODEL_ID", "k2-fsa/OmniVoice")),
            device_map=str(args.device_map or ""),
            dtype=str(args.dtype or "float16"),
            language=str(args.language or "vietnamese"),
            num_step=int(args.num_step) if args.num_step is not None else 8,
            guidance_scale=float(args.guidance_scale) if args.guidance_scale is not None else 2.0,
            seed=int(args.seed) if args.seed is not None else None,
        )
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}), file=sys.stderr)
        return 1

    log.info("done elapsed_sec=%.2f", time.perf_counter() - t0)
    print(json.dumps({"ok": True, "out": out_path}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
