import { BadRequestException } from "@nestjs/common";
import { spawnSync } from "child_process";
import { lstatSync, openSync, readSync, realpathSync, statSync, closeSync } from "fs";
import { basename, extname, isAbsolute, relative, resolve } from "path";

import { TikTokVideoMetadata } from "./tiktok.types";

export type VideoValidationIssue = {
  source: "kitlabs" | "tiktok";
  code: string;
  message: string;
};

function validationError(issue: VideoValidationIssue): BadRequestException {
  return new BadRequestException(issue);
}

export function validateKiTLabsUpload(sourcePath: string): {
  realPath: string;
  fileName: string;
  sizeBytes: number;
} {
  if (!isAbsolute(sourcePath)) {
    throw validationError({
      source: "kitlabs",
      code: "ABSOLUTE_PATH_REQUIRED",
      message: "Đường dẫn video không hợp lệ.",
    });
  }
  let configuredRoots: string[];
  let realPath: string;
  let link: ReturnType<typeof lstatSync>;
  let file: ReturnType<typeof statSync>;
  try {
    configuredRoots = (process.env.TIKTOK_NATIVE_IMPORT_ROOTS ?? "")
      .split(";")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => realpathSync(resolve(item)));
    realPath = realpathSync(sourcePath);
    link = lstatSync(sourcePath);
    file = statSync(realPath);
  } catch {
    throw validationError({
      source: "kitlabs",
      code: "LOCAL_FILE_NOT_FOUND",
      message: "Không tìm thấy tệp video cục bộ.",
    });
  }
  if (link.isSymbolicLink() || !file.isFile()) {
    throw validationError({
      source: "kitlabs",
      code: "REGULAR_FILE_REQUIRED",
      message: "Video phải là tệp cục bộ thông thường.",
    });
  }
  if (
    configuredRoots.length > 0 &&
    !configuredRoots.some((root) => {
      const rel = relative(root, realPath);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
  ) {
    throw validationError({
      source: "kitlabs",
      code: "PATH_NOT_PICKED",
      message: "Tệp không nằm trong vùng được native picker cho phép.",
    });
  }
  const maxBytes = Number(process.env.TIKTOK_LOCAL_MAX_BYTES ?? 4_294_967_296);
  if (file.size <= 0 || file.size > maxBytes) {
    throw validationError({
      source: "kitlabs",
      code: "LOCAL_SIZE_LIMIT",
      message: "Kích thước tệp vượt giới hạn tài nguyên cục bộ.",
    });
  }
  const fd = openSync(realPath, "r");
  const header = Buffer.alloc(12);
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const isIsoBmff = header.subarray(4, 8).toString("ascii") === "ftyp";
  const isWebm = header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (!isIsoBmff && !isWebm) {
    throw validationError({
      source: "kitlabs",
      code: "INVALID_VIDEO_SIGNATURE",
      message: "Tệp đã chọn không có chữ ký video được hỗ trợ.",
    });
  }
  return { realPath, fileName: basename(realPath), sizeBytes: file.size };
}

export function inspectVideo(filePath: string, sizeBytes: number): TikTokVideoMetadata {
  const ffprobe = process.env.FFPROBE_BIN ?? "ffprobe";
  const result = spawnSync(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,avg_frame_rate:format=format_name,duration",
      "-of",
      "json",
      filePath,
    ],
    { encoding: "utf8", windowsHide: true, timeout: Number(process.env.TIKTOK_FFPROBE_TIMEOUT_MS ?? 15_000) },
  );
  if (result.status !== 0) {
    throw validationError({
      source: "kitlabs",
      code: "VIDEO_METADATA_UNREADABLE",
      message: "Không thể đọc metadata video.",
    });
  }
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{ codec_name?: string; width?: number; height?: number; avg_frame_rate?: string }>;
    format?: { format_name?: string; duration?: string };
  };
  const stream = parsed.streams?.[0];
  const [num, den] = String(stream?.avg_frame_rate ?? "0/1")
    .split("/")
    .map(Number);
  return {
    format: extname(filePath).slice(1).toLowerCase() || String(parsed.format?.format_name ?? ""),
    codec: String(stream?.codec_name ?? "").toLowerCase(),
    sizeBytes,
    width: Number(stream?.width ?? 0),
    height: Number(stream?.height ?? 0),
    fps: den ? num / den : 0,
    durationSeconds: Number(parsed.format?.duration ?? 0),
  };
}

/**
 * TikTok Media Transfer Guide snapshot verified 2026-09-23.
 * Keep provider policy separate from local KiTLabs resource limits.
 */
export function validateTikTokVideo(metadata: TikTokVideoMetadata, creatorMaxDuration?: number): void {
  const reject = (code: string, message: string) => {
    throw validationError({ source: "tiktok", code, message });
  };
  if (!["mp4", "mov", "webm"].includes(metadata.format))
    reject("FORMAT_UNSUPPORTED", "TikTok không hỗ trợ định dạng video này.");
  if (!["h264", "hevc", "h265", "vp8", "vp9"].includes(metadata.codec))
    reject("CODEC_UNSUPPORTED", "TikTok không hỗ trợ codec video này.");
  if (metadata.sizeBytes > 4_294_967_296) reject("FILE_TOO_LARGE", "Video vượt giới hạn 4 GB của TikTok.");
  if (metadata.fps < 23 || metadata.fps > 60)
    reject("FPS_OUT_OF_RANGE", "TikTok yêu cầu tốc độ khung hình từ 23 đến 60 FPS.");
  if (metadata.width < 360 || metadata.height < 360 || metadata.width > 4096 || metadata.height > 4096) {
    reject("DIMENSIONS_OUT_OF_RANGE", "Kích thước video nằm ngoài giới hạn 360–4096 px của TikTok.");
  }
  if (creatorMaxDuration && metadata.durationSeconds > creatorMaxDuration) {
    reject("DURATION_EXCEEDS_CREATOR_LIMIT", "Video dài hơn giới hạn hiện tại của tài khoản TikTok.");
  }
}
