"""
Step 1 – VSE mode: VideoSubFinder (frame detection) + PaddleOCR (text recognition).

VideoSubFinder detects frames that contain hardsubs and writes RGB/Cleared images.
PaddleOCR reads those images and builds a .zh.srt timeline.

Binary layout (download via scripts/download_videosubfinder.sh):
    tools/video-pipeline/subfinder/
      linux/VideoSubFinderCli(.run)
      windows/VideoSubFinderWXW.exe
      macos/VideoSubFinderCli
"""

from __future__ import annotations

import multiprocessing
import os
import platform
import re
import shlex
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Callable

from subtitle.normalize import clean_text, same_subtitle_line
from subtitle.watermark import filter_watermarks, DEFAULT_WATERMARK_BLACKLIST
from subtitle.models import SubtitleSegment

_cfg: dict[str, Any] = {}
_SKIP_COMPILED: list = []

BUILTIN_SKIP_REGEXES = (
    r"(?i)^\s*(订阅|点赞|收藏|分享|转发|AlCheng动漫)\s*$",
    r"(?i)^\s*会员\s*\d*\s*$",
    r"(?i)^\s*温馨提示\s*$",
    r"^\s*\d{1,2}:\d{2}(:\d{2})?\s*[-–~至]\s*\d{1,2}:\d{2}(:\d{2})?\s*$",
)

_TIME_NAME_RE = re.compile(r"^(\d+)_(\d+)_(\d+)_(\d+)__")


def configure_step1_vse(
    *,
    log: Callable[[str], None],
    ffmpeg_bin: str,
    fmt_time: Callable,
    get_zh_srt_path: Callable[[], Path],
    log_dir: Path,
    script_dir: Path,
    # OCR
    lang: str,
    use_gpu: bool,
    use_angle_cls: bool,
    min_confidence: float,
    # ROI (fractions from frame bottom / sides — same semantics as PaddleOCR crop)
    subtitle_crop_band_hi: float,
    max_strip_height_ratio: float,
    crop_probe_h_trim_left_frac: float,
    crop_probe_h_trim_right_frac: float,
    # Merge / filter
    fuzzy_threshold: float,
    merge_gap_ms: int,
    min_duration_ms: int,
    watermark_blacklist: str = "",
    watermark_min_frames: int = 0,
    # VideoSubFinder
    vsf_cpu_cores: int = 0,
    vsf_use_cuda: bool = False,
    vsf_binary_path: str = "",
    vsf_use_docker: bool = True,
    vsf_docker_image: str = "kitools-videosubfinder",
) -> None:
    _cfg.clear()
    _cfg.update(
        log=log,
        ffmpeg_bin=str(ffmpeg_bin),
        fmt_time=fmt_time,
        get_zh_srt_path=get_zh_srt_path,
        log_dir=Path(log_dir),
        script_dir=Path(script_dir),
        lang=str(lang),
        use_gpu=bool(use_gpu),
        use_angle_cls=bool(use_angle_cls),
        min_confidence=float(min_confidence),
        subtitle_crop_band_hi=float(subtitle_crop_band_hi),
        max_strip_height_ratio=float(max_strip_height_ratio or 0),
        crop_probe_h_trim_left_frac=max(0.0, min(0.49, float(crop_probe_h_trim_left_frac))),
        crop_probe_h_trim_right_frac=max(0.0, min(0.49, float(crop_probe_h_trim_right_frac))),
        fuzzy_threshold=float(fuzzy_threshold),
        merge_gap_ms=int(merge_gap_ms),
        min_duration_ms=max(1, int(min_duration_ms)),
        watermark_blacklist=str(watermark_blacklist or ""),
        watermark_min_frames=max(0, int(watermark_min_frames)),
        vsf_cpu_cores=max(0, int(vsf_cpu_cores or 0)),
        vsf_use_cuda=bool(vsf_use_cuda),
        vsf_binary_path=str(vsf_binary_path or "").strip(),
        vsf_use_docker=bool(vsf_use_docker),
        vsf_docker_image=str(vsf_docker_image or "kitools-videosubfinder").strip() or "kitools-videosubfinder",
    )
    _rebuild_skip_regexes()


def run(video_path: Path) -> Path:
    return _ocr_with_vsf(Path(video_path))


def _rebuild_skip_regexes() -> None:
    global _SKIP_COMPILED
    compiled = []
    for p in BUILTIN_SKIP_REGEXES:
        try:
            compiled.append(re.compile(p))
        except re.error:
            pass
    _SKIP_COMPILED = compiled


def _should_skip_merged_text(text: str) -> bool:
    t = re.sub(r"\s+", " ", (text or "").strip())
    if not t:
        return True
    for cre in _SKIP_COMPILED:
        try:
            if cre.fullmatch(t):
                return True
        except re.error:
            continue
    return False


def _resolve_vsf_binary() -> Path:
    override = _cfg.get("vsf_binary_path") or ""
    if override:
        p = Path(override).expanduser()
        if not p.is_file():
            raise RuntimeError(f"Step1 VSE: vsf_binary_path not found: {p}")
        return p

    script_dir = Path(_cfg["script_dir"])
    system = platform.system()
    if system == "Windows":
        candidates = [
            script_dir / "subfinder" / "windows" / "VideoSubFinderWXW.exe",
        ]
    elif system == "Darwin":
        candidates = [
            script_dir / "subfinder" / "macos" / "VideoSubFinderCli",
        ]
    else:
        # Prefer the ELF binary — avoid chmod on .run (often EPERM on some mounts).
        candidates = [
            script_dir / "subfinder" / "linux" / "VideoSubFinderCli",
            script_dir / "subfinder" / "linux" / "VideoSubFinderCli.run",
        ]

    for c in candidates:
        if c.is_file():
            return c

    raise RuntimeError(
        "Step1 VSE: VideoSubFinder binary not found.\n"
        "  Run: bash tools/video-pipeline/scripts/download_videosubfinder.sh\n"
        f"  Expected under: {script_dir / 'subfinder'}"
    )


def _try_chmod_exec(path: Path) -> None:
    """Best-effort +x; ignore EPERM (common on noexec/ACL mounts)."""
    try:
        mode = path.stat().st_mode
        os.chmod(path, mode | 0o111)
    except OSError:
        pass


def _build_vsf_cmd(binary: Path, args: list[str]) -> list[str]:
    """
    Invoke VideoSubFinder without requiring chmod when possible.
    - ELF binary: run directly (or via /lib64/ld-linux if not executable)
    - .run shell wrapper: always via /bin/sh
    """
    if binary.suffix == ".run" or binary.name.endswith(".run"):
        return ["/bin/sh", str(binary), *args]

    _try_chmod_exec(binary)
    if os.access(binary, os.X_OK):
        return [str(binary), *args]

    # Not executable and chmod failed — still try direct path; if that fails caller sees stderr.
    # On Linux, running via sh does not work for ELF; try common dynamic linker.
    for ld in ("/lib64/ld-linux-x86-64.so.2", "/lib/ld-linux-x86-64.so.2"):
        if Path(ld).is_file():
            return [ld, str(binary), *args]
    return [str(binary), *args]


def _band_to_vsf_roi() -> tuple[float, float, float, float]:
    """
    Convert KiTLabs crop-from-bottom band → VideoSubFinder -te/-be/-le/-re.

    Matches VSE (YaoFANGUK) convention:
      top_end    = 1 - ymin_frac
      bottom_end = 1 - ymax_frac
      left_end   = xmin_frac
      right_end  = xmax_frac
    """
    hi = max(0.01, min(0.99, float(_cfg["subtitle_crop_band_hi"])))
    strip = float(_cfg.get("max_strip_height_ratio") or 0)
    lo = 0.0 if strip <= 0 else max(0.0, hi - strip)

    ymin = 1.0 - hi
    ymax = 1.0 - lo
    if ymax <= ymin + 1e-6:
        ymax = min(1.0, ymin + 0.05)

    xmin = float(_cfg["crop_probe_h_trim_left_frac"])
    xmax = 1.0 - float(_cfg["crop_probe_h_trim_right_frac"])
    if xmax <= xmin + 1e-6:
        xmin, xmax = 0.05, 0.95

    top_end = 1.0 - ymin
    bottom_end = 1.0 - ymax
    return top_end, bottom_end, xmin, xmax


def _parse_vsf_timestamp_ms(name: str) -> int | None:
    m = _TIME_NAME_RE.match(name)
    if not m:
        return None
    h, mi, s, ms = (int(m.group(i)) for i in range(1, 5))
    return ms + s * 1000 + mi * 60 * 1000 + h * 60 * 60 * 1000


def _collect_vsf_images(out_dir: Path) -> list[tuple[float, Path]]:
    """Prefer ClearedTXTImages (bg removed), fallback RGBImages."""
    for folder in ("ClearedTXTImages", "TXTImages", "RGBImages"):
        d = out_dir / folder
        if not d.is_dir():
            continue
        items: list[tuple[float, Path]] = []
        for p in sorted(d.iterdir()):
            if not p.is_file():
                continue
            if p.suffix.lower() not in (".jpeg", ".jpg", ".png", ".bmp", ".webp"):
                continue
            ms = _parse_vsf_timestamp_ms(p.name)
            if ms is None:
                continue
            items.append((ms / 1000.0, p))
        if items:
            return items
    return []


def _docker_sock_writable() -> bool:
    sock = Path("/var/run/docker.sock")
    try:
        return sock.exists() and os.access(sock, os.R_OK | os.W_OK)
    except OSError:
        return False


def _wrap_docker_cmd(cmd: list[str]) -> list[str]:
    """
    Prefer plain `docker` when the process can already write docker.sock.
    Otherwise wrap with `sg docker` so Nest gets the group without re-login.
    `sg` can hang on some PAM setups — disable with VSE_DOCKER_SG=0.
    """
    if platform.system() != "Linux":
        return cmd
    if _docker_sock_writable():
        return cmd
    if str(os.environ.get("VSE_DOCKER_SG", "1")).strip().lower() in ("0", "off", "false", "no"):
        return cmd
    if not Path("/usr/bin/sg").is_file() and not shutil.which("sg"):
        return cmd
    quoted = " ".join(shlex.quote(x) for x in cmd)
    return ["sg", "docker", "-c", quoted]


def _count_vsf_images(out_dir: Path) -> int:
    n = 0
    for folder in ("ClearedTXTImages", "TXTImages", "RGBImages"):
        d = out_dir / folder
        if not d.is_dir():
            continue
        try:
            n += sum(1 for p in d.iterdir() if p.is_file())
        except OSError:
            continue
    return n


def _run_subprocess_streaming(cmd: list[str], *, cwd: str, env: dict, out_dir: Path, log) -> int:
    """Run VSF with live logs + heartbeat (image count) so Nest does not look hung."""
    log(f"Step1 VSE: exec: {' '.join(cmd[:8])}{' …' if len(cmd) > 8 else ''}")
    log("Step1 VSE: VideoSubFinder đang quét video — có thể mất nhiều phút, chờ heartbeat…")

    proc = subprocess.Popen(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )

    t0 = time.time()
    last_beat = t0
    last_line_at = t0
    line_buf: list[str] = []

    assert proc.stdout is not None
    while True:
        line = proc.stdout.readline()
        now = time.time()
        if line:
            last_line_at = now
            text = line.rstrip()
            if text:
                line_buf.append(text)
                if len(line_buf) > 80:
                    line_buf = line_buf[-80:]
                # VSF Frame: / progress lines — always echo
                low = text.lower()
                if (
                    text.startswith("Frame:")
                    or "percent" in low
                    or "error" in low
                    or "fail" in low
                    or "search" in low
                ):
                    log(f"Step1 VSE: [vsf] {text[:300]}")
        elif proc.poll() is not None:
            break

        if now - last_beat >= 15:
            imgs = _count_vsf_images(out_dir)
            quiet = now - last_line_at
            log(
                f"Step1 VSE: heartbeat elapsed={now - t0:.0f}s "
                f"images={imgs} quiet={quiet:.0f}s pid={proc.pid}"
            )
            last_beat = now

        if line == "" and proc.poll() is None:
            time.sleep(0.2)

    code = proc.wait()
    elapsed = time.time() - t0
    imgs = _count_vsf_images(out_dir)
    log(f"Step1 VSE: process exit={code} elapsed={elapsed:.1f}s images={imgs}")
    if code != 0:
        tail = "\n".join(line_buf[-30:])
        raise RuntimeError(
            f"Step1 VSE: VideoSubFinder failed (code={code}, {elapsed:.1f}s).\n{tail}"
        )
    return code


def _run_videosubfinder(video_path: Path, out_dir: Path, empty_srt: Path) -> None:
    log = _cfg["log"]
    top_end, bottom_end, left_end, right_end = _band_to_vsf_roi()

    cpu_count = _cfg["vsf_cpu_cores"] or max(multiprocessing.cpu_count() - 2, 1)
    use_cuda = bool(_cfg.get("vsf_use_cuda"))
    use_docker = bool(_cfg.get("vsf_use_docker"))

    vsf_args: list[str] = ["--verbose", "-c", "-r"]
    if use_cuda:
        vsf_args.append("-uc")
    vsf_args += [
        "-te", f"{top_end:.6f}",
        "-be", f"{bottom_end:.6f}",
        "-le", f"{left_end:.6f}",
        "-re", f"{right_end:.6f}",
        "-nthr", str(cpu_count),
        "-ovocv",
    ]
    # Do NOT pass -dsi: PaddleOCR needs ClearedTXTImages/RGBImages on disk.

    log(
        f"Step1 VSE: VideoSubFinder ROI te={top_end:.3f} be={bottom_end:.3f} "
        f"le={left_end:.3f} re={right_end:.3f} cuda={use_cuda} nthr={cpu_count} docker={use_docker}"
    )

    video_path = video_path.resolve()
    out_dir = out_dir.resolve()
    empty_srt = empty_srt.resolve()
    if not video_path.is_file():
        raise RuntimeError(f"Step1 VSE: video not found: {video_path}")

    env = os.environ.copy()
    if use_docker:
        image = str(_cfg.get("vsf_docker_image") or "kitools-videosubfinder")
        in_dir = video_path.parent
        cmd = [
            "docker", "run", "--rm",
            "-v", f"{in_dir}:/vsf_in:ro",
            "-v", f"{out_dir}:/vsf_out",
            image,
            *vsf_args,
            "-i", f"/vsf_in/{video_path.name}",
            "-o", "/vsf_out",
            "-ces", f"/vsf_out/{empty_srt.name}",
        ]
        used_sg = not _docker_sock_writable()
        cmd = _wrap_docker_cmd(cmd)
        cwd = str(out_dir)
        log(
            f"Step1 VSE: docker image={image} video={video_path.name} "
            f"in={in_dir} out={out_dir} sg={used_sg}"
        )
    else:
        binary = _resolve_vsf_binary()
        native_args = [
            *vsf_args,
            "-i", str(video_path),
            "-o", str(out_dir),
            "-ces", str(empty_srt),
        ]
        cmd = _build_vsf_cmd(binary, native_args)
        cwd = str(binary.parent)
        lib_dir = str(binary.parent)
        env["LD_LIBRARY_PATH"] = f"{lib_dir}:{env.get('LD_LIBRARY_PATH', '')}"
        log(f"Step1 VSE: run {binary.name} …")

    try:
        _run_subprocess_streaming(cmd, cwd=cwd, env=env, out_dir=out_dir, log=log)
    except RuntimeError as exc:
        msg = str(exc)
        if use_docker and ("Unable to find image" in msg or "No such image" in msg):
            raise RuntimeError(
                f"{msg}\nBuild image first:\n"
                "  docker build -t kitools-videosubfinder tools/video-pipeline/subfinder"
            ) from exc
        if use_docker and "permission denied" in msg.lower() and "docker" in msg.lower():
            raise RuntimeError(
                f"{msg}\nDocker socket permission denied. Fix:\n"
                "  usermod -aG docker <nest-user> && restart Nest\n"
                "  or: chmod 666 /var/run/docker.sock\n"
                "  verify: docker run --rm kitools-videosubfinder -h"
            ) from exc
        raise
    log("Step1 VSE: VideoSubFinder done")


def _ocr_image(ocr, image_path: Path, use_angle_cls: bool) -> str:
    import cv2

    img = cv2.imread(str(image_path))
    if img is None:
        return ""
    try:
        result = ocr.ocr(img, cls=use_angle_cls)
        lines = result[0] if result and result[0] else []
    except Exception:
        return ""

    min_conf = float(_cfg["min_confidence"])
    texts: list[str] = []
    for item in lines or []:
        if not item or len(item) < 2:
            continue
        rec = item[1]
        text = str(rec[0]).strip() if rec else ""
        conf = float(rec[1]) if rec and len(rec) > 1 else 0.0
        if text and conf >= min_conf:
            texts.append(text)
    return " ".join(texts).strip()


def _ocr_with_vsf(video_path: Path) -> Path:
    log = _cfg["log"]
    log("Step1: OCR (VSE = VideoSubFinder + PaddleOCR)…")

    try:
        from paddleocr import PaddleOCR
    except ImportError:
        raise RuntimeError(
            "paddleocr chưa được cài đặt.\n"
            "  GPU: pip install paddlepaddle-gpu paddleocr\n"
            "  CPU: pip install paddlepaddle paddleocr"
        )

    work_dir = Path(_cfg["log_dir"]) / "step1_vse"
    shutil.rmtree(work_dir, ignore_errors=True)
    work_dir.mkdir(parents=True, exist_ok=True)
    empty_srt = work_dir / "raw_vsf.srt"

    _run_videosubfinder(video_path, work_dir, empty_srt)

    frames = _collect_vsf_images(work_dir)
    if not frames:
        raise RuntimeError(
            "Step1 VSE: VideoSubFinder không tạo được frame subtitle "
            "(RGBImages/ClearedTXTImages trống). Kiểm tra ROI / binary / video."
        )
    log(f"Step1 VSE: {len(frames)} subtitle frames from VideoSubFinder")

    ocr = PaddleOCR(
        lang=_cfg["lang"],
        use_angle_cls=_cfg["use_angle_cls"],
        device="gpu" if _cfg["use_gpu"] else "cpu",
    )
    log(f"Step1 VSE: PaddleOCR init lang={_cfg['lang']} gpu={_cfg['use_gpu']}")

    use_cls = bool(_cfg["use_angle_cls"])
    fuzzy_thr = float(_cfg["fuzzy_threshold"])
    raw_results: list[tuple[float, str]] = []
    for ts, img_path in frames:
        text = _ocr_image(ocr, img_path, use_cls)
        if text:
            raw_results.append((ts, text))

    log(f"Step1 VSE: OCR done — {len(frames)} frames, {len(raw_results)} with text")

    cleaned = [(ts, clean_text(t)) for ts, t in raw_results]
    cleaned = [(ts, t) for ts, t in cleaned if t]
    if not cleaned:
        raise RuntimeError("Step1 VSE: không có text nào sau cleaning.")

    # Estimate per-cue hold from median gap between VSF detections (fallback 0.5s).
    gaps = [cleaned[i][0] - cleaned[i - 1][0] for i in range(1, len(cleaned))]
    hold = 0.5
    if gaps:
        gaps_s = sorted(g for g in gaps if g > 0)
        if gaps_s:
            hold = max(0.2, min(2.0, gaps_s[len(gaps_s) // 2]))

    merge_gap_ms = int(_cfg["merge_gap_ms"])
    groups: list = []
    for ts, text in cleaned:
        if groups and same_subtitle_line(groups[-1][2], text, fuzzy_thr):
            groups[-1][1] = ts + hold
            if len(text) > len(groups[-1][2]):
                groups[-1][2] = text
        else:
            groups.append([ts, ts + hold, text])

    merged: list = []
    for block in groups:
        if (
            merged
            and same_subtitle_line(merged[-1][2], block[2], fuzzy_thr)
            and (block[0] - merged[-1][1]) * 1000 <= merge_gap_ms
        ):
            merged[-1][1] = block[1]
            if len(block[2]) > len(merged[-1][2]):
                merged[-1][2] = block[2]
        else:
            merged.append(list(block))

    kept = []
    skipped = 0
    for start, end, text in merged:
        if _should_skip_merged_text(text):
            skipped += 1
        else:
            kept.append((start, end, text))
    if skipped:
        log(f"Step1 VSE: skipped {skipped} block(s) (regex skip filter)")
    if not kept:
        raise RuntimeError("Step1 VSE: tất cả block bị lọc bởi regex skip filter.")

    wm_blacklist_str = _cfg.get("watermark_blacklist") or ""
    wm_blacklist = (
        tuple(s.strip() for s in wm_blacklist_str.split(",") if s.strip())
        if wm_blacklist_str
        else DEFAULT_WATERMARK_BLACKLIST
    )
    wm_segments = [SubtitleSegment(s, e, t, frame_count=1) for s, e, t in kept]
    wm_segments = filter_watermarks(
        wm_segments,
        blacklist=wm_blacklist,
        skip_regexes=_SKIP_COMPILED,
        min_frame_count=_cfg.get("watermark_min_frames", 0),
        total_scan_frames=len(frames),
        log=log,
    )
    kept = [(seg.start_sec, seg.end_sec, seg.text) for seg in wm_segments]
    if not kept:
        raise RuntimeError("Step1 VSE: tất cả block bị lọc bởi watermark filter.")

    min_dur = int(_cfg["min_duration_ms"])
    fmt_time = _cfg["fmt_time"]
    srt_path = _cfg["get_zh_srt_path"]()
    with open(srt_path, "w", encoding="utf8") as f:
        for i, (start, end, text) in enumerate(kept, 1):
            if (end - start) * 1000 < min_dur:
                end = start + min_dur / 1000.0
            f.write(f"{i}\n{fmt_time(start)} --> {fmt_time(end)}\n{text}\n\n")
    log(f"Step1 VSE: done — {len(kept)} blocks → {srt_path}")
    return srt_path
