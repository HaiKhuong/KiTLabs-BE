import json
import logging
import os
import glob
import subprocess
import sys
import traceback
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

TEMP_DIR = os.environ.get("TEMP_DIR") or os.path.join(
    os.environ.get("KITLABS_DATA_ROOT") or os.getcwd(), "temp", "ytdlp"
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("ytdlp-service")

_YTDLP_BIN_DIR = os.path.join(
    os.path.dirname(sys.executable),
    "Scripts" if os.name == "nt" else "bin",
)
if os.path.isdir(_YTDLP_BIN_DIR):
    os.environ["PATH"] = _YTDLP_BIN_DIR + os.pathsep + os.environ.get("PATH", "")


def _ytdlp_argv() -> list[str]:
    """Run yt-dlp via the same Python that hosts this service (desktop venv)."""
    return [sys.executable, "-m", "yt_dlp"]


def _is_youtube_url(url: str) -> bool:
    lower = (url or "").lower()
    return "youtube.com" in lower or "youtu.be" in lower


def _is_douyin_url(url: str) -> bool:
    lower = (url or "").lower()
    return "douyin.com" in lower or "iesdouyin.com" in lower


def _platform_args(url: str) -> list[str]:
    if _is_youtube_url(url):
        return ["--extractor-args", "youtube:player_client=android,web_safari"]
    if _is_douyin_url(url):
        return [
            "--add-header",
            "Referer:https://www.douyin.com/",
            "--user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        ]
    return []


def _http_error_from_exception(exc: Exception) -> HTTPException:
    if isinstance(exc, subprocess.TimeoutExpired):
        return HTTPException(status_code=504, detail="yt-dlp timed out while processing URL")

    detail = str(exc).strip() or "yt-dlp failed"
    lower = detail.lower()
    if any(
        token in lower
        for token in (
            "fresh cookies",
            "sign in",
            "cookies are needed",
            "login required",
            "cookie",
        )
    ):
        return HTTPException(status_code=422, detail=detail)

    if any(
        token in lower
        for token in (
            "downloaderror",
            "unsupported url",
            "unable to extract",
            "http error 400",
            "http error 403",
            "http error 404",
            "not available",
            "video unavailable",
            "is not a valid url",
        )
    ):
        return HTTPException(status_code=400, detail=detail)

    return HTTPException(status_code=500, detail=detail)


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
    media_format: Optional[str] = "video"


class PlaylistRequest(BaseModel):
    url: str
    cookie_content: Optional[str] = None


def _normalize_cookies_to_netscape(cookie_content: str) -> str:
    stripped = cookie_content.strip()
    if not stripped:
        return ""
    if stripped.startswith("# Netscape") or "\t" in stripped:
        return stripped.replace("\r\n", "\n").replace("\r", "\n")

    lines = ["# Netscape HTTP Cookie File"]
    if stripped.startswith("[") or stripped.startswith("{"):
        try:
            parsed = json.loads(stripped)
            items = parsed if isinstance(parsed, list) else parsed.get("cookies", [])
            for c in items:
                if not isinstance(c, dict) or not c.get("name"):
                    continue
                domain = str(c.get("domain") or ".douyin.com")
                include_sub = "TRUE" if domain.startswith(".") else "FALSE"
                path = str(c.get("path") or "/")
                secure = "TRUE" if c.get("secure") else "FALSE"
                expires = int(c.get("expirationDate") or c.get("expires") or 0)
                lines.append(f"{domain}\t{include_sub}\t{path}\t{secure}\t{expires}\t{c['name']}\t{c.get('value', '')}")
            if len(lines) > 1:
                return "\n".join(lines) + "\n"
        except Exception:
            pass

    if "=" in stripped and "\t" not in stripped:
        raw = stripped[7:].strip() if stripped.lower().startswith("cookie:") else stripped
        for part in raw.split(";"):
            if "=" not in part:
                continue
            name, val = part.split("=", 1)
            name = name.strip()
            if name:
                lines.append(f".douyin.com\tTRUE\t/\tTRUE\t0\t{name}\t{val.strip()}")
        if len(lines) > 1:
            return "\n".join(lines) + "\n"

    return stripped.replace("\r\n", "\n").replace("\r", "\n")


def _write_cookies_temp(cookie_content: Optional[str]) -> Optional[str]:
    if not cookie_content:
        return None
    normalized = _normalize_cookies_to_netscape(cookie_content)
    if not normalized:
        return None
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


def _extract_via_cli(url: str, cookie_path: Optional[str], extra: Optional[list] = None) -> dict:
    """Fallback: call yt-dlp CLI with --dump-json."""
    cmd = [*_ytdlp_argv(), "--dump-json", "--no-check-certificates", "--no-warnings", "--no-playlist"]
    cmd += _platform_args(url)
    if extra:
        cmd += extra
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

        if info.get("entries"):
            urls = []
            for entry in info.get("entries") or []:
                if not entry:
                    continue
                entry_url = entry.get("webpage_url") or entry.get("url")
                if entry_url and str(entry_url).startswith("http"):
                    urls.append(entry_url)
            return {
                "type": "playlist",
                "title": info.get("title"),
                "urls": urls,
            }

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
            "type": "video",
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
        raise _http_error_from_exception(e)
    finally:
        _cleanup(cookie_path)


@app.post("/extract-profile")
def extract_profile(req: ExtractProfileRequest):
    logger.info("Extract profile: url=%s, max_videos=%d", req.url, req.max_videos)
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        cmd = [
            *_ytdlp_argv(),
            "--dump-json",
            "--no-check-certificates", "--no-warnings",
            "--playlist-end", str(req.max_videos),
        ]
        cmd += _platform_args(req.url)
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
        raise _http_error_from_exception(e)
    finally:
        _cleanup(cookie_path)


@app.post("/playlist")
def extract_playlist(req: PlaylistRequest):
    logger.info("Playlist request: url=%s", req.url)
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        cmd = [
            *_ytdlp_argv(),
            "--flat-playlist",
            "--print", "url",
            "--no-check-certificates",
            "--no-warnings",
        ]
        cmd += _platform_args(req.url)
        if cookie_path:
            cmd += ["--cookies", cookie_path]
        cmd.append(req.url)

        logger.info("CLI playlist: %s", " ".join(cmd))
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=180)

        if result.returncode != 0:
            err = result.stderr.strip()
            logger.error("CLI stderr: %s", err)
            raise Exception(err or f"yt-dlp exited with code {result.returncode}")

        urls = []
        seen = set()
        for line in result.stdout.splitlines():
            url = line.strip()
            if not url.startswith("http") or url in seen:
                continue
            seen.add(url)
            urls.append(url)

        if not urls:
            raise HTTPException(status_code=400, detail="No playlist entries found")

        return {"urls": urls, "count": len(urls)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Playlist error: %s\n%s", str(e), traceback.format_exc())
        raise _http_error_from_exception(e)
    finally:
        _cleanup(cookie_path)


@app.post("/download")
def download_video(req: DownloadRequest):
    media_format = (req.media_format or "video").strip().lower()
    logger.info(
        "Download request: url=%s, format_id=%s, media_format=%s",
        req.url,
        req.format_id,
        media_format,
    )
    cookie_path = _write_cookies_temp(req.cookie_content)
    download_id = uuid.uuid4().hex
    out_dir = os.path.join(TEMP_DIR, download_id)
    os.makedirs(out_dir, exist_ok=True)

    try:
        cmd = [
            *_ytdlp_argv(),
            "--no-check-certificates", "--no-warnings",
            "--no-playlist",
            "-o", os.path.join(out_dir, "%(title).80s.%(ext)s"),
        ]
        cmd += _platform_args(req.url)
        if media_format == "audio":
            cmd += ["-x", "--audio-format", "mp3", "-f", "bestaudio/best"]
        else:
            cmd += ["--merge-output-format", "mp4"]
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
        raise _http_error_from_exception(e)
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
