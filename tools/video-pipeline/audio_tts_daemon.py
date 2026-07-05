"""
Long-running OmniVoice TTS daemon — giữ model + voice prompt trong RAM (như auto_vietsub_pro).

Protocol: JSON lines trên stdin/stdout.
  → {"id":"<uuid>","cmd":"synthesize","payload":{...}}
  ← {"id":"<uuid>","ok":true}
  ← {"id":"<uuid>","ok":false,"error":"..."}

Payload synthesize:
  mode?: "direct" | "pauses"   — direct = synthesize_to_wav (nhanh, video scene)
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from typing import Any, Dict

import pipeline_cache  # noqa: F401 — cache HF/torch trước torch-heavy imports
from audio_tts_bridge import run_synthesize_payload


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


def _handle_request(req: Dict[str, Any]) -> None:
    req_id = str(req.get("id") or "")
    cmd = str(req.get("cmd") or "").strip().lower()

    if cmd == "ping":
        _emit({"id": req_id, "ok": True, "pong": True})
        return

    if cmd == "synthesize":
        payload = req.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        run_synthesize_payload(payload)
        _emit({"id": req_id, "ok": True})
        return

    if cmd == "shutdown":
        _emit({"id": req_id, "ok": True, "type": "bye"})
        raise SystemExit(0)

    raise ValueError(f"unknown cmd: {cmd!r}")


def main() -> None:
    _log("audio_tts_daemon: starting")
    _emit({"type": "ready", "version": 1, "pid": os.getpid()})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = ""
        try:
            req = json.loads(line)
            if not isinstance(req, dict):
                raise ValueError("request must be a JSON object")
            req_id = str(req.get("id") or "")
            _handle_request(req)
        except SystemExit:
            raise
        except Exception as exc:
            tb = traceback.format_exc()
            _log(tb)
            _emit({"id": req_id, "ok": False, "error": str(exc) or exc.__class__.__name__})


if __name__ == "__main__":
    main()
