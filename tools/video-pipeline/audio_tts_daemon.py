#!/usr/bin/env python3
"""
Long-running OmniVoice worker — giữ process Python (cache model trong RAM như auto_vietsub_pro).

Giao thức: mỗi dòng stdin/stdout là một JSON object.
Request:  {"id":"...","cmd":"ping"|"synthesize"|"shutdown", ...}
Response: {"id":"...","ok":true,...} | {"id":"...","ok":false,"error":"..."}
Log: stderr ([omnivoice-daemon] / [omnivoice]).
"""

from __future__ import annotations

import json
import logging
import sys
import time
import traceback
from typing import Any

logging.basicConfig(
    level=logging.INFO,
    format="[omnivoice-daemon] %(message)s",
    stream=sys.stderr,
    force=True,
)
log = logging.getLogger("omnivoice-daemon")


def _respond(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    rid = str(req.get("id") or "")
    cmd = str(req.get("cmd") or "").strip().lower()

    if cmd == "ping":
        return {"id": rid, "ok": True, "pong": True}

    if cmd == "shutdown":
        return {"id": rid, "ok": True, "shutdown": True}

    if cmd == "synthesize":
        from audio_tts_worker import run_synthesis_from_payload

        t0 = time.perf_counter()
        out_path = run_synthesis_from_payload(req)
        elapsed = time.perf_counter() - t0
        log.info("synthesize done id=%s elapsed_sec=%.2f out=%s", rid, elapsed, out_path)
        return {"id": rid, "ok": True, "out": out_path, "elapsed_sec": round(elapsed, 3)}

    return {"id": rid, "ok": False, "error": f"unknown cmd: {cmd!r}"}


def main() -> int:
    log.info("ready (model loads on first synthesize; reused after that)")
    _respond({"id": "__ready__", "ok": True})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            _respond({"id": None, "ok": False, "error": f"invalid json: {e}"})
            continue

        if not isinstance(req, dict):
            _respond({"id": None, "ok": False, "error": "request must be a JSON object"})
            continue

        rid = str(req.get("id") or "")
        try:
            res = _handle(req)
            _respond(res)
            if res.get("shutdown"):
                log.info("shutdown requested id=%s", rid)
                return 0
        except Exception as e:
            log.error("request failed id=%s: %s", rid, e)
            log.debug(traceback.format_exc())
            _respond({"id": rid, "ok": False, "error": str(e)})

    log.info("stdin closed — exiting")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
