"""GFlow Generator: Google Flow Video (t2v/i2v) & Image (t2i/i2i) generator with account pool failover."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import sys
from pathlib import Path
from typing import Optional

CURRENT_DIR = Path(__file__).resolve().parent
if str(CURRENT_DIR) not in sys.path:
    sys.path.insert(0, str(CURRENT_DIR))

from gflow_pool import AllAccountsExhaustedError, gflow_account_pool  # noqa: E402

logger = logging.getLogger("gflow_generator")

DEFAULT_VIDEO_TIMEOUT_SEC = 300
DEFAULT_IMAGE_TIMEOUT_SEC = 120


def get_gflow_bin() -> str:
    """Finds gflow CLI binary across common Python environments."""
    exe = "gflow.exe" if os.name == "nt" else "gflow"
    scripts_dir = "Scripts" if os.name == "nt" else "bin"
    candidates = [
        Path(sys.executable).parent / exe,
        CURRENT_DIR / ".venv" / scripts_dir / exe,
        CURRENT_DIR.parent / ".venv" / scripts_dir / exe,
        CURRENT_DIR.parent.parent / ".venv" / scripts_dir / exe,
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return shutil.which("gflow") or exe


def strip_image_metadata(input_path: str, output_path: str) -> str:
    """Strips EXIF metadata from reference image to prevent upload rejection."""
    try:
        from PIL import Image

        in_p = Path(input_path)
        out_p = Path(output_path)
        out_p.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(in_p) as img:
            clean_img = Image.new(img.mode, img.size)
            clean_img.putdata(list(img.getdata()))
            clean_img.save(str(out_p))
        return str(out_p)
    except Exception:
        return input_path


async def _run_subprocess(cmd: list[str], env: dict[str, str], timeout_sec: int) -> tuple[int, str, str]:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        try:
            proc.kill()
            await proc.wait()
        except Exception:
            pass
        raise TimeoutError(f"gflow CLI timed out after {timeout_sec}s")

    return (
        proc.returncode or 0,
        stdout_bytes.decode("utf-8", errors="replace"),
        stderr_bytes.decode("utf-8", errors="replace"),
    )


def _build_env(voice: Optional[str] = None) -> dict[str, str]:
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["GFLOW_CLI_UPDATE_CHECK"] = "0"
    env["GFLOW_CLI_FLOW_HOST"] = "flow.google.com"
    if voice:
        env["GFLOW_CLI_VOICE"] = str(voice).strip()
    return env


def _classify_and_mark_failure(profile: Optional[str], combined_out: str) -> bool:
    """Returns True if the caller should retry with another account."""
    lower_out = combined_out.lower()
    if any(k in lower_out for k in ("insufficientcredits", "credit", "0 remaining", "hết lượt")):
        if profile:
            gflow_account_pool.mark_quota_blocked(profile, reason="Hết credit")
        return True
    if "429" in lower_out or "rate limit" in lower_out:
        if profile:
            gflow_account_pool.mark_rate_limited(profile, cooldown_seconds=600, reason="Rate limit 429")
        return True
    return False


class GFlowGenerator:
    """Google Flow Video & Image Generator with pool failover."""

    def __init__(self):
        self.gflow_bin = get_gflow_bin()

    async def generate_video(
        self,
        prompt: str,
        output_file: str | Path,
        reference_image: Optional[str | Path] = None,
        aspect: str = "16:9",
        model: str = "omni-flash",
        resolution: str = "720p",
        duration: int = 8,
        voice: Optional[str] = None,
        max_attempts: Optional[int] = None,
        timeout_sec: int = DEFAULT_VIDEO_TIMEOUT_SEC,
    ) -> tuple[Path, Optional[str]]:
        out_path = Path(output_file).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        available_count = gflow_account_pool.get_available_profiles_count()
        attempts = max_attempts or max(1, available_count)
        attempted_profiles: set[str] = set()

        for attempt in range(attempts):
            leased_profile = await gflow_account_pool.acquire_profile(exclude=attempted_profiles)
            if leased_profile:
                attempted_profiles.add(leased_profile)
            elif available_count > 0 and attempt == 0:
                raise AllAccountsExhaustedError("Tất cả tài khoản Google Flow trong Pool đều đang bận hoặc hết quota.")

            tmp_dir = out_path.parent / f"_tmp_{out_path.stem}"
            tmp_dir.mkdir(parents=True, exist_ok=True)

            try:
                ref_img = None
                if reference_image and Path(reference_image).exists():
                    ref_img = strip_image_metadata(str(reference_image), str(tmp_dir / f"clean_{Path(reference_image).name}"))

                cmd = [self.gflow_bin, "video"]
                if ref_img and Path(ref_img).exists():
                    cmd.extend(["i2v", "-i", str(ref_img), prompt])
                else:
                    cmd.extend(["t2v", prompt])

                cmd.extend(
                    [
                        "--aspect",
                        aspect,
                        "--model",
                        model.replace("_", "-"),
                        "--out-dir",
                        str(tmp_dir),
                        "--duration",
                        str(duration),
                        "--json",
                    ]
                )
                if model == "omni-flash":
                    cmd.extend(["--resolution", "360p" if resolution == "360p" else "720p"])
                if leased_profile:
                    cmd.extend(["--profile", leased_profile])

                returncode, stdout, stderr = await _run_subprocess(cmd, _build_env(voice), timeout_sec)
                combined = f"{stderr}\n{stdout}"

                if returncode != 0:
                    if _classify_and_mark_failure(leased_profile, combined):
                        continue
                    raise RuntimeError(f"Google Flow video lỗi: {combined[:500]}")

                mp4_files = [f for f in tmp_dir.glob("*.mp4") if f.stat().st_size > 1024]
                if not mp4_files:
                    raise FileNotFoundError(f"Không tìm thấy file mp4 sau khi render trong: {tmp_dir}")

                shutil.move(str(mp4_files[0]), str(out_path))
                if leased_profile:
                    gflow_account_pool.record_usage(leased_profile)
                return out_path, leased_profile
            finally:
                shutil.rmtree(str(tmp_dir), ignore_errors=True)
                if leased_profile:
                    gflow_account_pool.release_profile(leased_profile)

        raise AllAccountsExhaustedError("Tất cả tài khoản Google Flow đều đã thử nhưng không thể tạo video.")

    async def generate_image(
        self,
        prompt: str,
        output_file: str | Path,
        reference_image: Optional[str | Path] = None,
        aspect: str = "16:9",
        model: Optional[str] = None,
        max_attempts: Optional[int] = None,
        timeout_sec: int = DEFAULT_IMAGE_TIMEOUT_SEC,
    ) -> tuple[Path, Optional[str]]:
        out_path = Path(output_file).resolve()
        out_path.parent.mkdir(parents=True, exist_ok=True)

        available_count = gflow_account_pool.get_available_profiles_count()
        attempts = max_attempts or max(1, available_count)
        attempted_profiles: set[str] = set()

        for attempt in range(attempts):
            leased_profile = await gflow_account_pool.acquire_profile(exclude=attempted_profiles)
            if leased_profile:
                attempted_profiles.add(leased_profile)
            elif available_count > 0 and attempt == 0:
                raise AllAccountsExhaustedError("Tất cả tài khoản Google Flow trong Pool đều đang bận hoặc hết quota.")

            tmp_dir = out_path.parent / f"_tmp_{out_path.stem}"
            tmp_dir.mkdir(parents=True, exist_ok=True)

            try:
                ref_img = None
                if reference_image and Path(reference_image).exists():
                    ref_img = strip_image_metadata(str(reference_image), str(tmp_dir / f"clean_{Path(reference_image).name}"))

                cmd = [self.gflow_bin, "image"]
                if ref_img and Path(ref_img).exists():
                    cmd.extend(["i2i", prompt, "--ref", str(ref_img)])
                else:
                    cmd.extend(["t2i", prompt])

                cmd.extend(["--aspect", aspect, "--out-dir", str(tmp_dir), "--json"])
                if model and model != "gflow-imagen":
                    cmd.extend(["--model", model.replace("_", "-")])
                if leased_profile:
                    cmd.extend(["--profile", leased_profile])

                returncode, stdout, stderr = await _run_subprocess(cmd, _build_env(), timeout_sec)
                combined = f"{stderr}\n{stdout}"

                if returncode != 0:
                    if _classify_and_mark_failure(leased_profile, combined):
                        continue
                    raise RuntimeError(f"Google Flow image lỗi: {combined[:500]}")

                img_files = [
                    f
                    for ext in ("*.png", "*.jpg", "*.jpeg", "*.webp")
                    for f in tmp_dir.glob(ext)
                    if f.stat().st_size > 256
                ]
                if not img_files:
                    raise FileNotFoundError(f"Không tìm thấy file ảnh sau khi render trong: {tmp_dir}")

                shutil.move(str(img_files[0]), str(out_path))
                if leased_profile:
                    gflow_account_pool.record_usage(leased_profile)
                return out_path, leased_profile
            finally:
                shutil.rmtree(str(tmp_dir), ignore_errors=True)
                if leased_profile:
                    gflow_account_pool.release_profile(leased_profile)

        raise AllAccountsExhaustedError("Tất cả tài khoản Google Flow đều đã thử nhưng không thể tạo ảnh.")


gflow_generator = GFlowGenerator()
