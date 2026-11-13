"""
Persistent Warm TTS Worker (Daemon) cho Menu Voice / Audio Studio.

Giữ model TTS (OmniVoice / VieNeu / VoxCPM2) trên GPU giữa các lần bấm Tạo Voice
để triệt tiêu ~18–22s Cold-Start (import torch/transformers + load weights lên VRAM).
Tự động giải phóng VRAM sau khi không sử dụng (mặc định 600s = 10 phút) hoặc khi
video pipeline (auto_vietsub_pro) yêu cầu nhường GPU.
"""

from __future__ import annotations

import gc
import json
import os
import secrets
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path
from typing import Any, Dict, Optional

_PIPELINE_DIR = Path(__file__).resolve().parent
if str(_PIPELINE_DIR) not in sys.path:
    sys.path.insert(0, str(_PIPELINE_DIR))

_STATE_FILE = Path(tempfile.gettempdir()) / "kitlabs_tts_warm_worker.json"
_FORWARD_ENV_PREFIXES = (
    "OMNIVOICE_",
    "VIENEU_",
    "VOXCPM2_",
    "AUDIO_",
    "STEP3_",
    "HF_",
    "HUGGING",
    "KITLABS_",
    "FFMPEG_",
)


def _collect_forward_env() -> Dict[str, str]:
    out: Dict[str, str] = {}
    for k, v in os.environ.items():
        if k.startswith(_FORWARD_ENV_PREFIXES) and isinstance(v, str):
            out[k] = v
    return out


def _read_state() -> Optional[Dict[str, Any]]:
    try:
        if not _STATE_FILE.is_file():
            return None
        return json.loads(_STATE_FILE.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_state(data: Dict[str, Any]) -> None:
    try:
        tmp = _STATE_FILE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(data), encoding="utf-8")
        tmp.replace(_STATE_FILE)
    except Exception:
        pass


def _remove_state_if_pid(pid: int) -> None:
    try:
        st = _read_state()
        if st and int(st.get("pid") or 0) == pid:
            _STATE_FILE.unlink(missing_ok=True)
    except Exception:
        pass


def _send_rpc(
    state: Dict[str, Any],
    request: Dict[str, Any],
    timeout: float = 600.0,
) -> Dict[str, Any]:
    host = str(state.get("host") or "127.0.0.1")
    port = int(state.get("port") or 0)
    if port <= 0:
        raise ConnectionError("Invalid warm worker port")
    with socket.create_connection((host, port), timeout=3.0) as sock:
        sock.settimeout(timeout)
        payload_bytes = (json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8")
        sock.sendall(payload_bytes)
        sock.shutdown(socket.SHUT_WR)
        chunks: list[bytes] = []
        while True:
            buf = sock.recv(65536)
            if not buf:
                break
            chunks.append(buf)
    raw = b"".join(chunks).decode("utf-8", errors="replace").strip()
    if not raw:
        raise ConnectionError("Empty response from warm worker")
    return json.loads(raw.splitlines()[-1])


def _is_worker_alive(state: Optional[Dict[str, Any]]) -> bool:
    if not state:
        return False
    if str(state.get("python") or "") != sys.executable:
        return False
    try:
        resp = _send_rpc(
            state,
            {"token": state.get("token"), "action": "ping"},
            timeout=2.0,
        )
        return bool(resp.get("ok"))
    except Exception:
        return False


def shutdown_tts_warm_worker() -> bool:
    """Tắt warm worker (nếu đang chạy) để giải phóng VRAM ngay lập tức."""
    state = _read_state()
    if not state:
        return False
    try:
        _send_rpc(
            state,
            {"token": state.get("token"), "action": "shutdown"},
            timeout=3.0,
        )
        return True
    except Exception:
        try:
            _STATE_FILE.unlink(missing_ok=True)
        except Exception:
            pass
        return False


def _spawn_daemon() -> Optional[Dict[str, Any]]:
    script_path = str(Path(__file__).resolve())
    env = dict(os.environ)
    env["KITLABS_TTS_WORKER_DIRECT"] = "1"
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"

    creationflags = 0
    if sys.platform == "win32":
        creationflags = (
            getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)
            | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
            | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x00000200)
        )
    breakaway_flag = 0x01000000 if sys.platform == "win32" else 0

    try:
        with open(os.devnull, "rb") as devnull_in, open(os.devnull, "ab") as devnull_out:
            try:
                subprocess.Popen(
                    [sys.executable, script_path, "--daemon"],
                    cwd=str(_PIPELINE_DIR),
                    env=env,
                    stdin=devnull_in,
                    stdout=devnull_out,
                    stderr=devnull_out,
                    creationflags=creationflags | breakaway_flag,
                    close_fds=(sys.platform != "win32"),
                )
            except OSError:
                subprocess.Popen(
                    [sys.executable, script_path, "--daemon"],
                    cwd=str(_PIPELINE_DIR),
                    env=env,
                    stdin=devnull_in,
                    stdout=devnull_out,
                    stderr=devnull_out,
                    creationflags=creationflags,
                    close_fds=(sys.platform != "win32"),
                )
    except Exception:
        return None

    deadline = time.monotonic() + 8.0
    while time.monotonic() < deadline:
        time.sleep(0.08)
        st = _read_state()
        if _is_worker_alive(st):
            return st
    return None


def is_warm_worker_enabled() -> bool:
    if os.getenv("KITLABS_TTS_WORKER_DIRECT") == "1":
        return False
    raw = (os.getenv("AUDIO_WARM_WORKER") or "1").strip().lower()
    return raw not in ("0", "false", "no", "off")


def run_via_warm_worker(task: str, payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Gửi tác vụ TTS sang tiến trình warm worker.
    - Trả về dict kết quả (vd `{"ok": True, "result": ...}`) nếu chạy qua daemon thành công.
    - Trả về `None` nếu không kết nối được daemon (caller tự fallback chạy trực tiếp).
    - Raise RuntimeError nếu tác vụ TTS bên trong daemon báo lỗi.
    """
    if not is_warm_worker_enabled():
        return None

    state = _read_state()
    if not _is_worker_alive(state):
        if state:
            shutdown_tts_warm_worker()
        state = _spawn_daemon()
    if not state:
        return None

    try:
        resp = _send_rpc(
            state,
            {
                "token": state.get("token"),
                "action": "run",
                "task": task,
                "payload": payload,
                "env": _collect_forward_env(),
            },
            timeout=720.0,
        )
    except ConnectionError:
        return None
    except Exception:
        return None

    if not resp.get("ok"):
        err_msg = str(resp.get("error") or "Warm worker task failed")
        raise RuntimeError(err_msg)
    return resp


# ============================================================================
# Daemon Server Implementation
# ============================================================================

_worker_lock = threading.Lock()
_last_activity = time.monotonic()
_active_requests = 0
_loaded_engine: Optional[str] = None


def _unload_other_engines(target_engine: str) -> None:
    global _loaded_engine
    eng = str(target_engine or "omnivoice").strip().lower()
    if _loaded_engine is not None and _loaded_engine != eng:
        try:
            if _loaded_engine == "omnivoice":
                import omnivoice_tts

                omnivoice_tts.reset_omnivoice_session()
            elif _loaded_engine == "vieneu":
                import vieneu_tts

                if hasattr(vieneu_tts, "reset_vieneu_session"):
                    vieneu_tts.reset_vieneu_session()
            elif _loaded_engine == "voxcpm2":
                import voxcpm2_tts

                if hasattr(voxcpm2_tts, "reset_voxcpm2_session"):
                    voxcpm2_tts.reset_voxcpm2_session()
        except Exception:
            pass
        try:
            import torch

            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    _loaded_engine = eng


def _serializable_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in payload.items():
        if isinstance(v, Path):
            out[k] = str(v)
        else:
            out[k] = v
    return out


def _execute_task(task: str, payload: Dict[str, Any], env_updates: Dict[str, str]) -> Any:
    for k, v in (env_updates or {}).items():
        if isinstance(k, str) and isinstance(v, str):
            os.environ[k] = v

    engine = str(payload.get("engine") or "omnivoice").strip().lower()
    _unload_other_engines(engine)

    if task == "pause_tts":
        from audio_tts_with_pauses import _synthesize_with_pause_settings_direct

        _synthesize_with_pause_settings_direct(**payload)
        return {"out_wav": str(payload.get("out_wav") or "")}

    if task == "srt_timeline_tts":
        from audio_srt_timeline_tts import _run_srt_timeline_direct

        return _run_srt_timeline_direct(payload)

    raise ValueError(f"Unknown warm worker task: {task!r}")


def _handle_client(conn: socket.socket, expected_token: str, srv: socket.socket) -> None:
    global _last_activity, _active_requests
    try:
        conn.settimeout(30.0)
        data = b""
        while b"\n" not in data and len(data) < 16 * 1024 * 1024:
            chunk = conn.recv(65536)
            if not chunk:
                break
            data += chunk
        if not data:
            return
        req = json.loads(data.decode("utf-8", errors="replace").strip())
        if req.get("token") != expected_token:
            conn.sendall(b'{"ok":false,"error":"unauthorized"}\n')
            return

        action = str(req.get("action") or "")
        if action == "ping":
            conn.sendall(b'{"ok":true,"status":"ready"}\n')
            return

        if action == "shutdown":
            conn.sendall(b'{"ok":true,"status":"shutting_down"}\n')
            try:
                conn.close()
                srv.close()
            except Exception:
                pass
            _remove_state_if_pid(os.getpid())
            os._exit(0)

        if action == "run":
            task = str(req.get("task") or "")
            payload = req.get("payload") or {}
            env_updates = req.get("env") or {}
            with _worker_lock:
                _active_requests += 1
                _last_activity = time.monotonic()
                try:
                    result = _execute_task(task, payload, env_updates)
                    resp = {"ok": True, "result": result}
                except Exception as exc:
                    resp = {
                        "ok": False,
                        "error": f"{exc}\n{traceback.format_exc()[-1500:]}",
                    }
                finally:
                    _last_activity = time.monotonic()
                    _active_requests -= 1
            conn.sendall((json.dumps(resp, ensure_ascii=False) + "\n").encode("utf-8"))
    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


def run_daemon_main() -> None:
    global _last_activity
    os.environ["KITLABS_TTS_WORKER_DIRECT"] = "1"
    idle_sec = max(60, int(os.getenv("AUDIO_WARM_IDLE_SEC") or "600"))
    token = secrets.token_hex(16)

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = int(srv.getsockname()[1])

    _write_state(
        {
            "host": "127.0.0.1",
            "port": port,
            "pid": os.getpid(),
            "token": token,
            "python": sys.executable,
            "started_at": time.time(),
        }
    )

    def _idle_watchdog() -> None:
        while True:
            time.sleep(10.0)
            if _active_requests <= 0 and (time.monotonic() - _last_activity) > idle_sec:
                _remove_state_if_pid(os.getpid())
                os._exit(0)

    threading.Thread(target=_idle_watchdog, daemon=True).start()

    try:
        while True:
            conn, _ = srv.accept()
            threading.Thread(
                target=_handle_client,
                args=(conn, token, srv),
                daemon=True,
            ).start()
    except Exception:
        pass
    finally:
        _remove_state_if_pid(os.getpid())


if __name__ == "__main__":
    if "--daemon" in sys.argv:
        run_daemon_main()
    elif "--shutdown" in sys.argv:
        shutdown_tts_warm_worker()

