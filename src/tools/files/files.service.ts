import { Injectable, Logger } from "@nestjs/common";
import { existsSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "path";

const logger = new Logger("FilesService");

/** Project-root upload dir — never relative to tools/video-pipeline cwd. */
export function resolveUploadRoot(): string {
  const raw = (process.env.UPLOAD_DIR ?? "uploads").trim() || "uploads";
  return isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
}

export function resolveUploadDestination(folder?: string | null, userId?: string | null): string {
  const folderName = (folder && folder.trim().length > 0 ? folder.trim() : "videos").replace(
    /[^a-zA-Z0-9-_]/g,
    "_",
  );
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

@Injectable()
export class FilesService {
  ensureUploadFolder(folder?: string, userId?: string): string {
    const targetFolder = resolveUploadDestination(folder, userId);
    if (!existsSync(targetFolder)) {
      mkdirSync(targetFolder, { recursive: true });
    }
    return targetFolder;
  }
}
