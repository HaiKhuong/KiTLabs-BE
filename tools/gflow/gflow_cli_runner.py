"""Unified CLI runner invoked by KiTLabs-BE NestJS services."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from gflow_generator import (  # noqa: E402
    _resolve_playwright_browsers_path,
    get_gflow_bin,
    gflow_generator,
    resolve_chromium_browser,
)
from gflow_pool import gflow_account_pool  # noqa: E402


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _has_real_google_chrome() -> bool:
    local = os.environ.get("LOCALAPPDATA", "")
    pf = os.environ.get("PROGRAMFILES", r"C:\Program Files")
    pf86 = os.environ.get("PROGRAMFILES(X86)", r"C:\Program Files (x86)")
    return any(
        os.path.exists(p)
        for p in (
            os.path.join(pf, r"Google\Chrome\Application\chrome.exe"),
            os.path.join(pf86, r"Google\Chrome\Application\chrome.exe"),
            os.path.join(local, r"Google\Chrome\Application\chrome.exe"),
        )
    )


def _handle_login(profile: str) -> int:
    gflow_bin = get_gflow_bin()
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    pw_path = _resolve_playwright_browsers_path()
    if pw_path and not env.get("PLAYWRIGHT_BROWSERS_PATH"):
        env["PLAYWRIGHT_BROWSERS_PATH"] = pw_path

    # Use 'chrome' only when real Google Chrome is installed (so Playwright channel='chrome' matches).
    # Otherwise use 'internal' (Playwright's bundled Chromium) so login & generation share the exact same version.
    browser_strategy = "chrome" if _has_real_google_chrome() else "internal"

    proc = subprocess.run(
        [gflow_bin, "auth", "login", "--profile", profile, "--browser", browser_strategy],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )
    if proc.returncode != 0:
        _emit({"ok": False, "error": (proc.stderr or proc.stdout or "Đăng nhập trình duyệt thất bại").strip()[:500]})
        return 1
    summary = gflow_account_pool.get_pool_status_summary()
    _emit({"ok": True, "profile": profile, "browser": browser_strategy, "pool": summary})
    return 0


def _handle_open_chrome(profile: str) -> int:
    browser_bin = resolve_chromium_browser()
    if not browser_bin:
        _emit({"ok": False, "error": "Không tìm thấy trình duyệt Chromium (Chrome, Edge, Cốc Cốc, Opera...) trên máy."})
        return 1
    user_dir = Path(os.environ.get("LOCALAPPDATA", "")) / "ffroliva" / "gflow-cli" / f"profile_{profile}"
    if not user_dir.exists():
        _emit({"ok": False, "error": f"Không tìm thấy thư mục profile '{profile}'."})
        return 1
    subprocess.Popen([browser_bin, f"--user-data-dir={user_dir}", "https://flow.google.com"])
    _emit({"ok": True, "profile": profile, "browser": browser_bin})
    return 0


async def _handle_generate_video() -> int:
    raw = sys.stdin.read().strip()
    data = json.loads(raw) if raw else {}
    out_path, used_profile = await gflow_generator.generate_video(
        prompt=data["prompt"],
        output_file=data["outputFile"],
        reference_image=data.get("referenceImage"),
        reference_images=data.get("referenceImages"),
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
        reference_images=data.get("referenceImages"),
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
