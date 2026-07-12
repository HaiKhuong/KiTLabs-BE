import os
import glob
import tempfile
import uuid
from contextlib import asynccontextmanager
from typing import Optional

import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

TEMP_DIR = "/tmp/ytdlp"


@asynccontextmanager
async def lifespan(app: FastAPI):
    os.makedirs(TEMP_DIR, exist_ok=True)
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
    path = os.path.join(TEMP_DIR, f"cookies_{uuid.uuid4().hex}.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write(cookie_content)
    return path


def _cleanup(path: Optional[str]):
    if path and os.path.exists(path):
        try:
            os.remove(path)
        except OSError:
            pass


def _base_opts(cookie_path: Optional[str] = None) -> dict:
    opts: dict = {
        "quiet": True,
        "no_warnings": True,
        "no_check_certificates": True,
    }
    if cookie_path:
        opts["cookiefile"] = cookie_path
    return opts


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/extract")
def extract_video(req: ExtractRequest):
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        opts = _base_opts(cookie_path)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(req.url, download=False)

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
            })

        formats.sort(key=lambda x: x.get("height") or 0, reverse=True)

        thumbnails = info.get("thumbnails", [])
        thumbnail = thumbnails[-1]["url"] if thumbnails else info.get("thumbnail")

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
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(cookie_path)


@app.post("/extract-profile")
def extract_profile(req: ExtractProfileRequest):
    cookie_path = _write_cookies_temp(req.cookie_content)
    try:
        opts = _base_opts(cookie_path)
        opts["playlistend"] = req.max_videos
        opts["extract_flat"] = False

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(req.url, download=False)

        if not info:
            raise HTTPException(status_code=400, detail="Could not extract profile info")

        entries = info.get("entries", [])
        if not entries:
            raise HTTPException(
                status_code=400,
                detail="URL is a single video. Use /extract instead.",
            )

        videos = []
        for entry in entries:
            if not entry:
                continue

            entry_formats = entry.get("formats", [])
            video_formats = [
                f for f in entry_formats if f.get("vcodec", "none") != "none"
            ]
            best_height = 0
            if video_formats:
                best_height = max(
                    (f.get("height") or 0) for f in video_formats
                )

            thumbnails = entry.get("thumbnails", [])
            thumb = thumbnails[-1]["url"] if thumbnails else entry.get("thumbnail")

            videos.append({
                "id": entry.get("id"),
                "title": entry.get("title"),
                "thumbnail": thumb,
                "duration": entry.get("duration"),
                "best_height": best_height,
                "webpage_url": entry.get("webpage_url"),
            })

        return {
            "uploader": info.get("uploader") or info.get("title"),
            "uploader_id": info.get("uploader_id") or info.get("id"),
            "videos": videos,
        }
    except yt_dlp.utils.DownloadError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        _cleanup(cookie_path)


@app.post("/download")
def download_video(req: DownloadRequest):
    cookie_path = _write_cookies_temp(req.cookie_content)
    download_id = uuid.uuid4().hex
    out_dir = os.path.join(TEMP_DIR, download_id)
    os.makedirs(out_dir, exist_ok=True)

    try:
        opts = _base_opts(cookie_path)
        opts["outtmpl"] = os.path.join(out_dir, "%(title).80s.%(ext)s")
        opts["merge_output_format"] = "mp4"

        if req.format_id:
            opts["format"] = req.format_id
        else:
            opts["format"] = "bestvideo*+bestaudio/best"

        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.download([req.url])

        files = glob.glob(os.path.join(out_dir, "*"))
        if not files:
            raise HTTPException(status_code=500, detail="Download produced no files")

        filepath = files[0]
        filename = os.path.basename(filepath)

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
    except yt_dlp.utils.DownloadError as e:
        _cleanup_dir(out_dir)
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        raise
    except Exception as e:
        _cleanup_dir(out_dir)
        raise HTTPException(status_code=500, detail=str(e))
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
