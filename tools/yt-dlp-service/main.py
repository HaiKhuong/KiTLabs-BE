import json
import logging
import os
import glob
import subprocess
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

TEMP_DIR = "/tmp/ytdlp"

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ytdlp-service")


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(TEMP_DIR, exist_ok=True)
    logger.info("yt-dlp version: %s", yt_dlp.version.__version__)
    yield


app = FastAPI(title="yt-dlp Service", lifespan=lifespan)


class ExtractRequest(BaseModel):
    url: str
    cookie_content: Optional[str] = None


class ExtractProfileRequest(BaseModel):
    url: str
    cookie_content: Optional[str] = None
    max_videos: int = 20


class DownloadRequest(BaseModel):
    url: str
    format_id: Optional[str] = None
    cookie_content: Optional[str] = None


def _write_cookies_temp(cookie_content: Optional[str]) -> Optional[str]:
    if not cookie_content:
        return None
    normalized = cookie_content.replace("\r\n", "\n").replace("\r", "\n")
    path = os.path.join(TEMP_DIR, f"cookies_{uuid.uuid4().hex}.txt")
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(normalized)
    logger.info("Wrote cookies to %s (%d bytes)", path, len(normalized))
    return path


def _cleanup(path: Optional[str]):
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


def _extract_via_cli(url: str, cookie_path: Optional[str]) -> dict:
    """Fallback: call yt-dlp CLI with --dump-json."""
    cmd = ["yt-dlp", "--dump-json", "--no-check-certificates", "--no-warnings"]
    if cookie_path:
        cmd += ["--cookies", cookie_path]
    cmd.append(url)

    logger.info("CLI fallback: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    if result.returncode != 0:
        err = result.stderr.strip()
        logger.error("CLI stderr: %s", err)
        raise Exception(err or f"yt-dlp exited with code {result.returncode}")

    return json.loads(result.stdout)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "ytdlp_version": yt_dlp.version.__version__,
    }


@app.post("/extract")
def extract_video(req: ExtractRequest):
    logger.info("Extract request: url=%s, has_cookies=%s", req.url, bool(req.cookie_content))
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        info = _extract_via_cli(req.url, cookie_path)

        if not info:
            raise HTTPException(status_code=400, detail="Could not extract video info")

        if "entries" in info:
            raise HTTPException(
                status_code=400,
                detail="URL is a playlist/profile. Use /extract-profile instead.",
            )

        formats = []
        for f in info.get("formats", []):
            if f.get("vcodec", "none") == "none":
                continue
            formats.append({
                "format_id": f.get("format_id"),
                "height": f.get("height"),
                "width": f.get("width"),
                "ext": f.get("ext"),
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "vcodec": f.get("vcodec"),
                "acodec": f.get("acodec"),
                "fps": f.get("fps"),
                "tbr": f.get("tbr"),
                "url": f.get("url"),
            })

        formats.sort(key=lambda x: x.get("height") or 0, reverse=True)

        thumbnails = info.get("thumbnails", [])
        thumbnail = thumbnails[-1]["url"] if thumbnails else info.get("thumbnail")

        logger.info("Extract success: id=%s, formats=%d", info.get("id"), len(formats))
        return {
            "id": info.get("id"),
            "title": info.get("title"),
            "thumbnail": thumbnail,
            "duration": info.get("duration"),
            "uploader": info.get("uploader"),
            "uploader_id": info.get("uploader_id"),
            "webpage_url": info.get("webpage_url"),
            "formats": formats,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Extract error: %s\n%s", str(e), traceback.format_exc())
        detail = str(e)
        status = 500
        if "Fresh cookies" in detail or "DownloadError" in detail:
            status = 400
        raise HTTPException(status_code=status, detail=detail)
    finally:
        _cleanup(cookie_path)


@app.post("/extract-profile")
def extract_profile(req: ExtractProfileRequest):
    logger.info("Extract profile: url=%s, max_videos=%d", req.url, req.max_videos)
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        cmd = [
            "yt-dlp", "--dump-json",
            "--no-check-certificates", "--no-warnings",
            "--playlist-end", str(req.max_videos),
        ]
        if cookie_path:
            cmd += ["--cookies", cookie_path]
        cmd.append(req.url)

        logger.info("CLI: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)

        if result.returncode != 0:
            err = result.stderr.strip()
            logger.error("CLI stderr: %s", err)
            raise Exception(err or f"yt-dlp exited with code {result.returncode}")

        videos = []
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            entry = json.loads(line)

            entry_formats = entry.get("formats", [])
            video_formats = [
                f for f in entry_formats if f.get("vcodec", "none") != "none"
            ]
            best_height = 0
            if video_formats:
                best_height = max((f.get("height") or 0) for f in video_formats)
            mapped_formats = [{
                "format_id": f.get("format_id"),
                "height": f.get("height"),
                "width": f.get("width"),
                "ext": f.get("ext"),
                "filesize": f.get("filesize") or f.get("filesize_approx"),
                "vcodec": f.get("vcodec"),
                "acodec": f.get("acodec"),
                "fps": f.get("fps"),
                "tbr": f.get("tbr"),
                "url": f.get("url"),
            } for f in video_formats]
            mapped_formats.sort(key=lambda x: x.get("height") or 0, reverse=True)

            thumbnails = entry.get("thumbnails", [])
            thumb = thumbnails[-1]["url"] if thumbnails else entry.get("thumbnail")

            videos.append({
                "id": entry.get("id"),
                "title": entry.get("title"),
                "thumbnail": thumb,
                "duration": entry.get("duration"),
                "best_height": best_height,
                "webpage_url": entry.get("webpage_url"),
                "formats": mapped_formats,
            })

        if not videos:
            raise HTTPException(status_code=400, detail="No videos found in profile")

        logger.info("Profile extract success: videos=%d", len(videos))
        return {
            "uploader": videos[0].get("uploader") if videos else None,
            "uploader_id": None,
            "videos": videos,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Profile error: %s\n%s", str(e), traceback.format_exc())
        detail = str(e)
        status = 500
        if "Fresh cookies" in detail:
            status = 400
        raise HTTPException(status_code=status, detail=detail)
    finally:
        _cleanup(cookie_path)


@app.post("/download")
def download_video(req: DownloadRequest):
    logger.info("Download request: url=%s, format_id=%s", req.url, req.format_id)
    cookie_path = _write_cookies_temp(req.cookie_content)
    download_id = uuid.uuid4().hex
    out_dir = os.path.join(TEMP_DIR, download_id)
    os.makedirs(out_dir, exist_ok=True)

    try:
        cmd = [
            "yt-dlp",
            "--no-check-certificates", "--no-warnings",
            "-o", os.path.join(out_dir, "%(title).80s.%(ext)s"),
            "--merge-output-format", "mp4",
        ]
        if req.format_id:
            cmd += ["-f", req.format_id]
        else:
            cmd += ["-f", "bestvideo*+bestaudio/best"]
        if cookie_path:
            cmd += ["--cookies", cookie_path]
        cmd.append(req.url)

        logger.info("CLI download: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)

        if result.returncode != 0:
            err = result.stderr.strip()
            logger.error("Download stderr: %s", err)
            raise Exception(err or f"yt-dlp exited with code {result.returncode}")

        files = glob.glob(os.path.join(out_dir, "*"))
        if not files:
            raise HTTPException(status_code=500, detail="Download produced no files")

        filepath = files[0]
        filename = os.path.basename(filepath)
        logger.info("Download success: %s", filename)

        def iter_file():
            try:
                with open(filepath, "rb") as f:
                    while chunk := f.read(1024 * 1024):
                        yield chunk
            finally:
                _cleanup(filepath)
                try:
                    os.rmdir(out_dir)
                except OSError:
                    pass

        return StreamingResponse(
            iter_file(),
            media_type="application/octet-stream",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Download error: %s\n%s", str(e), traceback.format_exc())
        _cleanup_dir(out_dir)
        detail = str(e)
        status = 500
        if "Fresh cookies" in detail:
            status = 400
        raise HTTPException(status_code=status, detail=detail)
    finally:
        _cleanup(cookie_path)


def _cleanup_dir(dir_path: str):
    if os.path.isdir(dir_path):
        for f in glob.glob(os.path.join(dir_path, "*")):
            _cleanup(f)
        try:
            os.rmdir(dir_path)
        except OSError:
            pass
