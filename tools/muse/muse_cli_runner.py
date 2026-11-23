"""Unified CLI runner for Muse.ai invoked by KiTLabs-BE NestJS services."""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

from muse_cli import cli as muse_cli_mod
from muse_cli.gateway import (
    AuthError,
    Gateway,
    GatewayError,
    fetch_access_token,
    fetch_hatch_token,
    fetch_session_info,
    load_cookies,
)

STUDIO_THREAD_TITLE = "KiTLabs Studio"
DEFAULT_IMAGE_TIMEOUT_SEC = 180
DEFAULT_VIDEO_TIMEOUT_SEC = 420
POLL_INTERVAL_SEC = 1.5
SETTLE_SEC = 15.0

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv"}


def _emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    data = json.loads(raw)
    return data if isinstance(data, dict) else {}


def _parse_cookie_input(raw_cookie: str) -> str:
    text = (raw_cookie or "").strip()
    if not text:
        return ""
    if text.lower().startswith("cookie:"):
        text = text.split(":", 1)[1].strip()
    if text.startswith("{") or "# Netscape HTTP Cookie File" in text or "\t" in text:
        fd, tmp_path = tempfile.mkstemp(prefix="muse_ck_", suffix=".txt")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            return load_cookies(tmp_path)
        finally:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
    return text


def _resolve_cookies(payload: dict[str, Any]) -> str:
    inline = _parse_cookie_input(str(payload.get("cookies") or ""))
    if inline:
        return inline
    cookie_file = str(payload.get("cookieFile") or "").strip()
    if cookie_file and os.path.exists(cookie_file):
        return load_cookies(cookie_file)
    default_file = os.path.expanduser("~/.config/muse-cli/cookies.txt")
    if os.path.exists(default_file):
        return load_cookies(default_file)
    raise AuthError("Chưa cấu hình cookie Muse.ai (hatch_sess). Vui lòng nhập cookie trong Settings → Muse AI.")


def _connect_with_cookies(cookies: str) -> Gateway:
    if "hatch_sess=" not in cookies:
        raise AuthError("Cookie Muse.ai không hợp lệ (thiếu hatch_sess).")
    cached = muse_cli_mod._cached_tokens(cookies)
    if cached:
        try:
            return Gateway(cookies, **cached)
        except TimeoutError:
            raise
        except Exception:
            muse_cli_mod._drop_tokens()
    vm_id = os.environ.get("MUSE_VM_ID") or fetch_session_info(cookies)["vm_id"]
    access_token = fetch_access_token(cookies)
    hatch_token = fetch_hatch_token(cookies, access_token, vm_id)
    gw = Gateway(cookies, vm_id=vm_id, access_token=access_token, hatch_token=hatch_token)
    muse_cli_mod._save_tokens(
        cookies,
        {"vm_id": vm_id, "access_token": access_token, "hatch_token": hatch_token},
    )
    return gw


def _ensure_studio_thread(gw: Gateway, preferred_thread_id: Optional[str] = None) -> str:
    sess = gw.call_json("sessions.list")
    sessions = sess.get("sessions", []) if isinstance(sess, dict) else []
    if preferred_thread_id:
        for s in sessions:
            if s.get("session_id") == preferred_thread_id and not s.get("archived"):
                return preferred_thread_id
    for s in sessions:
        if (s.get("title") or "").strip() == STUDIO_THREAD_TITLE and not s.get("archived"):
            sid = s.get("session_id")
            if sid:
                return str(sid)
    created = gw.call_json("session.start", body={"origin": "fresh", "lifecycle": "persistent"})
    sid = created.get("session_id") or (created.get("session") or {}).get("session_id")
    if not sid:
        raise GatewayError(-1, "Không thể tạo side chat KiTLabs Studio trên Muse.ai")
    try:
        gw.call_json("session.rename", body={"session_id": sid, "title": STUDIO_THREAD_TITLE})
    except Exception:
        pass
    return str(sid)


def _format_image_prompt(data: dict[str, Any]) -> str:
    prompt = str(data.get("prompt") or "").strip()
    parts = [f"Generate an image: {prompt}"]
    aspect = str(data.get("aspect") or "").strip()
    style = str(data.get("style") or "").strip()
    neg = str(data.get("negativePrompt") or "").strip()
    hints = []
    if aspect:
        hints.append(f"aspect ratio {aspect}")
    if style:
        hints.append(f"style {style}")
    if neg:
        hints.append(f"avoid: {neg}")
    if hints:
        parts.append(f"Requirements: {', '.join(hints)}.")
    parts.append("Please generate the image file and attach it directly.")
    return "\n".join(parts)


def _format_video_prompt(data: dict[str, Any]) -> str:
    prompt = str(data.get("prompt") or "").strip()
    parts = [f"Generate a video: {prompt}"]
    aspect = str(data.get("aspect") or "").strip()
    duration = data.get("duration")
    hints = []
    if aspect:
        hints.append(f"aspect ratio {aspect}")
    if duration:
        hints.append(f"duration around {duration} seconds")
    if hints:
        parts.append(f"Requirements: {', '.join(hints)}.")
    parts.append("Please generate the video file (.mp4) and attach it directly.")
    return "\n".join(parts)


def _matches_media_kind(resource: dict[str, Any], media_kind: str) -> bool:
    path = str(resource.get("path") or "").split("?", 1)[0].lower()
    mime = str(resource.get("mime") or "").lower()
    kind = str(resource.get("kind") or "").lower()
    ext = Path(path).suffix
    if media_kind == "image":
        return mime.startswith("image/") or ext in IMAGE_EXTS or kind == "image"
    if media_kind == "video":
        return mime.startswith("video/") or ext in VIDEO_EXTS or kind == "video"
    return True


def _run_generation(data: dict[str, Any], media_kind: str) -> dict[str, Any]:
    cookies = _resolve_cookies(data)
    output_file = Path(str(data["outputFile"])).resolve()
    output_file.parent.mkdir(parents=True, exist_ok=True)
    default_timeout = DEFAULT_IMAGE_TIMEOUT_SEC if media_kind == "image" else DEFAULT_VIDEO_TIMEOUT_SEC
    timeout_sec = int(data.get("timeout") or default_timeout)
    full_prompt = _format_image_prompt(data) if media_kind == "image" else _format_video_prompt(data)
    node_id = os.environ.get("MUSE_NODE_ID") or secrets.token_hex(8)

    gw = _connect_with_cookies(cookies)
    try:
        thread_id = _ensure_studio_thread(gw, data.get("threadId"))
        scope = {"session_id": thread_id}
        h = gw.call_json("chat.history", body={"limit": 1, **scope})
        baseline = max((e.get("seq") or 0 for e in h.get("chat_events", [])), default=0)

        gw._open(
            "chat.stream",
            body={
                "items": [{"type": "text", "text": full_prompt}],
                "node_id": node_id,
                "capabilities": {},
                **scope,
            },
        )

        deadline = time.time() + timeout_sec
        reply = None
        while time.time() < deadline and reply is None:
            try:
                h = gw.call_json("chat.history", body={"limit": 10, **scope})
            except (GatewayError, TimeoutError):
                time.sleep(POLL_INTERVAL_SEC)
                continue
            evs = sorted(h.get("chat_events", []), key=lambda e: e.get("seq", 0))
            for ev in evs:
                if muse_cli_mod.is_reply(ev, baseline):
                    reply = muse_cli_mod.fmt_event(ev)
                    break
            if reply is None:
                time.sleep(POLL_INTERVAL_SEC)

        if reply is None:
            raise TimeoutError(f"Muse.ai không phản hồi trong {timeout_sec}s.")

        # Wait for generated media presentation event after text reply
        last_seq = reply.get("seq") or baseline
        quiet_since = time.time()
        found_resources: list[dict[str, Any]] = []
        while time.time() < deadline:
            h = gw.call_json("chat.history", body={"limit": 20, **scope})
            evs = h.get("chat_events", [])
            seq = max([e.get("seq") or 0 for e in evs] or [0])
            matched = []
            for ev in evs:
                if (ev.get("seq") or 0) > baseline:
                    for r in muse_cli_mod.event_resources(ev):
                        if _matches_media_kind(r, media_kind) and r["path"] not in [x["path"] for x in matched]:
                            matched.append(r)
            if matched:
                found_resources = matched
            if seq > last_seq:
                last_seq = seq
                quiet_since = time.time()
            elif found_resources and (time.time() - quiet_since >= 3.0):
                break
            elif time.time() - quiet_since >= SETTLE_SEC:
                break
            time.sleep(POLL_INTERVAL_SEC)

        if not found_resources:
            reply_preview = str(reply.get("text") or "").strip()[:240]
            raise GatewayError(
                -1,
                f"Muse.ai đã trả lời nhưng không tìm thấy file {media_kind}: {reply_preview or 'Không có file đính kèm'}",
            )

        target_res = found_resources[-1]
        raw_bytes = gw.download_file(target_res)
        tmp_path = output_file.with_suffix(output_file.suffix + ".part")
        tmp_path.write_bytes(raw_bytes)
        os.replace(tmp_path, output_file)

        return {
            "ok": True,
            "outputPath": str(output_file),
            "threadId": thread_id,
            "vmId": gw.vm_id,
            "replyText": reply.get("text") or "",
            "bytes": len(raw_bytes),
        }
    finally:
        gw.close()


def _handle_status(data: dict[str, Any]) -> int:
    cookies = _resolve_cookies(data)
    gw = _connect_with_cookies(cookies)
    try:
        sess = gw.call_json("sessions.list")
        unread = gw.call_json("chat.unread_count")
        ident = gw.call_json("identity")
        _emit(
            {
                "ok": True,
                "connected": True,
                "vmId": gw.vm_id,
                "sessions": len(sess.get("sessions", [])),
                "unread": unread,
                "identity": ident,
            }
        )
        return 0
    finally:
        gw.close()


def _handle_auth_export() -> int:
    jar, err = muse_cli_mod._browser_cookies()
    if err or not jar:
        _emit({"ok": False, "error": err or "Không đọc được cookie muse.ai từ Chrome."})
        return 1
    pairs = []
    seen = set()
    for c in jar:
        name = str(c.get("name") or "").strip()
        value = str(c.get("value") or "")
        if not name or name in seen:
            continue
        seen.add(name)
        pairs.append(f"{name}={value}")
    cookie_str = "; ".join(pairs)
    if "hatch_sess=" not in cookie_str:
        _emit({"ok": False, "error": "Tab muse.ai đang mở nhưng chưa đăng nhập (thiếu hatch_sess)."})
        return 1
    _emit({"ok": True, "cookies": cookie_str, "cookieCount": len(pairs)})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="KiTLabs Muse.ai CLI runner")
    parser.add_argument(
        "--action",
        required=True,
        choices=["status", "auth-export", "generate-image", "generate-video"],
    )
    args = parser.parse_args()

    try:
        data = _read_stdin_json()
        if args.action == "status":
            return _handle_status(data)
        if args.action == "auth-export":
            return _handle_auth_export()
        if args.action == "generate-image":
            _emit(_run_generation(data, "image"))
            return 0
        if args.action == "generate-video":
            _emit(_run_generation(data, "video"))
            return 0
        _emit({"ok": False, "error": f"Unknown action: {args.action}"})
        return 2
    except AuthError as exc:
        _emit({"ok": False, "error": f"Lỗi xác thực Muse.ai: {exc}", "code": "AUTH_ERROR"})
        return 2
    except TimeoutError as exc:
        _emit({"ok": False, "error": f"Muse.ai timeout: {exc}", "code": "TIMEOUT"})
        return 4
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
