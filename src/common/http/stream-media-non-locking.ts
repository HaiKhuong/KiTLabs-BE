import { execFile } from "child_process";
import { Request, Response } from "express";
import { closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from "fs";
import { basename, dirname } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/**
 * Maximum bytes read per HTTP 206 Range response (2 MB).
 * Reading a bounded slice into a Buffer and closing the file descriptor
 * immediately (`closeSync(fd)`) BEFORE writing to the HTTP response guarantees
 * that Node.js NEVER holds an open file handle on Windows while a `<video>`
 * or `<audio>` element is paused or buffering in the browser.
 */
const MAX_RANGE_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MB

const inFlightSnapshots = new Map<string, Promise<boolean>>();

function readSliceAndCloseImmediately(
  filePath: string,
  start: number,
  length: number,
): Buffer {
  if (length <= 0) return Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(length);
  const fd = openSync(filePath, "r");
  try {
    let totalRead = 0;
    while (totalRead < length) {
      const bytesRead = readSync(
        fd,
        buf,
        totalRead,
        length - totalRead,
        start + totalRead,
      );
      if (bytesRead <= 0) break;
      totalRead += bytesRead;
    }
    return totalRead === length ? buf : buf.subarray(0, totalRead);
  } finally {
    closeSync(fd);
  }
}

export function streamMediaFileNonLocking(
  filePath: string,
  req: Request,
  res: Response,
  options?: {
    contentType?: string;
    fileName?: string;
    disposition?: "inline" | "attachment";
  },
): Response {
  const { size: fileSize } = statSync(filePath);
  const fileName = options?.fileName || basename(filePath);
  const contentType = options?.contentType || "video/mp4";
  const disposition = options?.disposition || "inline";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader(
    "Content-Disposition",
    `${disposition}; filename="${encodeURIComponent(fileName)}"`,
  );
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Accept-Ranges, Content-Range, Content-Length, Content-Type",
  );

  if (fileSize <= 0) {
    res.status(200);
    res.setHeader("Content-Length", "0");
    return res.end();
  }

  const rangeHeader = req.headers.range;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
    if (!match) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.end();
    }

    const start = match[1] ? Number(match[1]) : 0;
    const requestedEnd = match[2] ? Number(match[2]) : fileSize - 1;
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(requestedEnd) ||
      start < 0 ||
      start >= fileSize ||
      start > requestedEnd
    ) {
      res.status(416);
      res.setHeader("Content-Range", `bytes */${fileSize}`);
      return res.end();
    }

    const end = Math.min(
      requestedEnd,
      start + MAX_RANGE_CHUNK_BYTES - 1,
      fileSize - 1,
    );
    const chunkSize = end - start + 1;
    const buffer = readSliceAndCloseImmediately(filePath, start, chunkSize);

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", String(buffer.length));
    return res.end(buffer);
  }

  // Non-range request: if small enough (<= 4MB), read all and close fd immediately
  if (fileSize <= MAX_RANGE_CHUNK_BYTES * 2) {
    const buffer = readSliceAndCloseImmediately(filePath, 0, fileSize);
    res.status(200);
    res.setHeader("Content-Length", String(buffer.length));
    return res.end(buffer);
  }

  // Large file without Range header: serve initial bounded chunk so fd closes immediately
  const end = Math.min(MAX_RANGE_CHUNK_BYTES - 1, fileSize - 1);
  const buffer = readSliceAndCloseImmediately(filePath, 0, end + 1);
  res.status(206);
  res.setHeader("Content-Range", `bytes 0-${end}/${fileSize}`);
  res.setHeader("Content-Length", String(buffer.length));
  return res.end(buffer);
}

/**
 * Extracts a single JPEG snapshot of the first frame of `videoPath` into `thumbPath`
 * using FFmpeg, closing the video file immediately once the frame is decoded.
 */
export async function ensureVideoFirstFrameSnapshot(
  videoPath: string,
  thumbPath: string,
): Promise<boolean> {
  if (!videoPath || !existsSync(videoPath)) return false;
  if (existsSync(thumbPath)) {
    try {
      if (statSync(thumbPath).size > 0) return true;
    } catch {
      // regenerate
    }
  }

  const existingJob = inFlightSnapshots.get(thumbPath);
  if (existingJob) return existingJob;

  const job = (async () => {
    try {
      mkdirSync(dirname(thumbPath), { recursive: true });
      const ffmpegBin = (process.env.FFMPEG_BIN || process.env.FFMPEG_PATH || "ffmpeg").trim() || "ffmpeg";

      for (const seekSec of ["0.1", "0"]) {
        try {
          await execFileAsync(
            ffmpegBin,
            [
              "-y",
              "-hide_banner",
              "-loglevel",
              "error",
              "-ss",
              seekSec,
              "-i",
              videoPath,
              "-frames:v",
              "1",
              "-vf",
              "scale='min(640,iw)':-2",
              "-q:v",
              "4",
              thumbPath,
            ],
            { timeout: 15_000, windowsHide: true },
          );
          if (existsSync(thumbPath) && statSync(thumbPath).size > 0) {
            return true;
          }
        } catch {
          // try fallback seek
        }
      }
      return false;
    } finally {
      inFlightSnapshots.delete(thumbPath);
    }
  })();

  inFlightSnapshots.set(thumbPath, job);
  return job;
}

