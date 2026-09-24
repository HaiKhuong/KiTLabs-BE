import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { existsSync, mkdirSync, readdirSync, rmdirSync, statSync, unlinkSync } from "fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "path";

import { isAppPlatform } from "../../common/desktop/request-platform";

import { resolveConfiguredPath } from "../../common/desktop/data-path";

const logger = new Logger("FilesService");

/** Project-root upload dir — never relative to tools/video-pipeline cwd. */
export function resolveUploadRoot(): string {
  return resolveConfiguredPath(process.env.UPLOAD_DIR, "uploads");
}

export function resolveUploadDestination(
  folder?: string | null,
  userId?: string | null,
  subfolder?: string | null,
): string {
  const folderName = (folder && folder.trim().length > 0 ? folder.trim() : "videos").replace(
    /[^a-zA-Z0-9-_]/g,
    "_",
  );
  const safeSubfolder = subfolder
    ? subfolder
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_")
    : "";
  if (safeSubfolder) {
    return join(resolveUploadRoot(), folderName, safeSubfolder);
  }
  const safeUserId = userId ? userId.replace(/[^a-zA-Z0-9-_]/g, "") : "";
  return safeUserId
    ? join(resolveUploadRoot(), folderName, safeUserId)
    : join(resolveUploadRoot(), folderName);
}

function isPathInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel.length > 0 && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

function allowedUploadRoots(): string[] {
  return [
    resolveUploadRoot(),
    resolve(process.cwd(), "tools", "video-pipeline", "uploads"),
  ];
}

/** Xóa file video nguồn trong uploads sau Step7 thành công. Không xóa workspace/logo/outro. */
export function deleteUploadedSourceVideo(filePath: string): boolean {
  const absolute = resolve(filePath.trim());
  if (!existsSync(absolute)) {
    return false;
  }
  const allowed = allowedUploadRoots().some((root) => isPathInside(root, absolute));
  if (!allowed) {
    logger.warn(`Skip delete source video (outside uploads): ${absolute}`);
    return false;
  }

  unlinkSync(absolute);
  logger.log(`Deleted uploaded source video: ${absolute}`);

  const parent = dirname(absolute);
  try {
    if (existsSync(parent) && readdirSync(parent).length === 0) {
      const videosRoot = join(resolveUploadRoot(), "videos");
      const pipelineVideosRoot = join(process.cwd(), "tools", "video-pipeline", "uploads", "videos");
      if (isPathInside(videosRoot, parent) || isPathInside(pipelineVideosRoot, parent)) {
        rmdirSync(parent);
      }
    }
  } catch {
    // Empty-dir cleanup is best-effort.
  }
  return true;
}

const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

@Injectable()
export class FilesService {
  ensureUploadFolder(folder?: string, userId?: string): string {
    const targetFolder = resolveUploadDestination(folder, userId);
    if (!existsSync(targetFolder)) {
      mkdirSync(targetFolder, { recursive: true });
    }
    return targetFolder;
  }

  resolveLocalPreviewAsset(rawPath: string): { absolutePath: string; contentType: string } {
    const trimmed = this.normalizePreviewPath(rawPath);
    if (!trimmed) {
      throw new BadRequestException("path is required");
    }
    const absolute = resolve(trimmed);
    const ext = extname(absolute).toLowerCase();
    const contentType = PREVIEW_CONTENT_TYPES[ext];
    if (!contentType) {
      throw new BadRequestException("Unsupported preview file type");
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new NotFoundException("Preview file not found");
    }
    if (!this.isAllowedPreviewPath(absolute)) {
      throw new BadRequestException("Preview path is not allowed");
    }
    return { absolutePath: absolute, contentType };
  }

  private normalizePreviewPath(rawPath: string): string {
    let trimmed = String(rawPath ?? "").trim();
    if (!trimmed) return "";
    if (/^file:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        trimmed = decodeURIComponent(parsed.pathname);
      } catch {
        trimmed = trimmed.replace(/^file:\/\//i, "");
      }
      if (/^\/[a-zA-Z]:/.test(trimmed)) {
        trimmed = trimmed.slice(1);
      }
    }
    return trimmed.replaceAll("\\", "/");
  }

  private isAllowedPreviewPath(absolute: string): boolean {
    if (isAppPlatform()) {
      return true;
    }
    const allowedRoots = [
      resolve(process.cwd(), "tools", "video-pipeline", "logo"),
      resolve(process.cwd(), "tools", "video-pipeline", "outro"),
      resolveUploadRoot(),
    ];
    return allowedRoots.some((root) => isPathInside(root, absolute) || resolve(root) === absolute);
  }
}
