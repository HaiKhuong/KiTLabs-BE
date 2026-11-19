"""Unified CLI runner invoked by KiTLabs-BE NestJS services."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from gflow_generator import get_gflow_bin, gflow_generator  # noqa: E402
from gflow_pool import gflow_account_pool  # noqa: E402


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _find_chrome_bin() -> str | None:
    candidates = [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        os.path.join(os.environ.get("LOCALAPPDATA", ""), r"Google\Chrome\Application\chrome.exe"),
    ]
    for c in candidates:
        if c and os.path.exists(c):
            return c
    return None


def _handle_login(profile: str) -> int:
    gflow_bin = get_gflow_bin()
    proc = subprocess.run(
        [gflow_bin, "auth", "login", "--profile", profile, "--browser", "chrome"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        _emit({"ok": False, "error": (proc.stderr or proc.stdout or "Đăng nhập Chrome thất bại").strip()[:500]})
        return 1
    summary = gflow_account_pool.get_pool_status_summary()
    _emit({"ok": True, "profile": profile, "pool": summary})
    return 0


def _handle_open_chrome(profile: str) -> int:
    chrome_bin = _find_chrome_bin()
    if not chrome_bin:
        _emit({"ok": False, "error": "Không tìm thấy Google Chrome trên máy."})
        return 1
    user_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "ffroliva" / "gflow-cli" / f"profile_{profile}"
    if not user_dir.exists():
        _emit({"ok": False, "error": f"Không tìm thấy thư mục profile '{profile}'."})
        return 1
    subprocess.Popen([chrome_bin, f"--user-data-dir={user_dir}", "https://flow.google.com"])
    _emit({"ok": True, "profile": profile})
    return 0


async def _handle_generate_video() -> int:
    raw = sys.stdin.read().strip()
    data = json.loads(raw) if raw else {}
    out_path, used_profile = await gflow_generator.generate_video(
        prompt=data["prompt"],
        output_file=data["outputFile"],
        reference_image=data.get("referenceImage"),
        aspect=data.get("aspect", "16:9"),
        model=data.get("model", "omni-flash"),
        resolution=data.get("resolution", "720p"),
        duration=int(data.get("duration", 8)),
        voice=data.get("voice"),
    )
    _emit({"ok": True, "outputPath": str(out_path), "profile": used_profile})
    return 0


async def _handle_generate_image() -> int:
    raw = sys.stdin.read().strip()
    data = json.loads(raw) if raw else {}
    out_path, used_profile = await gflow_generator.generate_image(
        prompt=data["prompt"],
        output_file=data["outputFile"],
        reference_image=data.get("referenceImage"),
        aspect=data.get("aspect", "16:9"),
        model=data.get("model"),
    )
    _emit({"ok": True, "outputPath": str(out_path), "profile": used_profile})
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="KiTLabs GFlow CLI Runner")
    parser.add_argument(
        "--action",
        required=True,
        choices=["status", "login", "open-chrome", "reset", "generate-video", "generate-image"],
    )
    parser.add_argument("--profile", type=str, default=None)
    parser.add_argument("--clear-usage", action="store_true")
    args = parser.parse_args()

    try:
        if args.action == "status":
            _emit({"ok": True, **gflow_account_pool.get_pool_status_summary()})
            return 0
        if args.action == "login":
            if not args.profile:
                _emit({"ok": False, "error": "Thiếu tên profile"})
                return 1
            return _handle_login(args.profile.strip())
        if args.action == "open-chrome":
            if not args.profile:
                _emit({"ok": False, "error": "Thiếu tên profile"})
                return 1
            return _handle_open_chrome(args.profile.strip())
        if args.action == "reset":
            reset_list = gflow_account_pool.reset_restrictions(args.profile)
            deleted = gflow_account_pool.reset_daily_usage(profile_name=args.profile) if args.clear_usage else 0
            _emit(
                {
                    "ok": True,
                    "resetProfiles": reset_list,
                    "deletedUsageRecords": deleted,
                    "pool": gflow_account_pool.get_pool_status_summary(),
                }
            )
            return 0
        if args.action == "generate-video":
            return asyncio.run(_handle_generate_video())
        if args.action == "generate-image":
            return asyncio.run(_handle_generate_image())
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
