import { BadRequestException, Injectable } from "@nestjs/common";
import { existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve, sep } from "path";

export type BrowseDirectoriesResult = {
  path: string;
  parent: string | null;
  directories: string[];
};

@Injectable()
export class FilesService {
  ensureUploadFolder(subFolder?: string): string {
    const baseFolder = process.env.UPLOAD_DIR ?? "uploads";
    const targetFolder = subFolder ? join(baseFolder, this.normalizeFolderName(subFolder)) : baseFolder;

    if (!existsSync(targetFolder)) {
      mkdirSync(targetFolder, { recursive: true });
    }
    return targetFolder;
  }

  /** Liệt kê folder con trên máy BE — chỉ trả path, không đọc/upload file. */
  browseDirectories(rawPath?: string): BrowseDirectoriesResult {
    const roots = this.getBrowseRoots();
    const requested = rawPath?.trim();
    const targetPath = requested ? this.assertAllowedBrowsePath(requested, roots) : roots[0];

    if (!existsSync(targetPath)) {
      throw new BadRequestException(`Directory not found: ${targetPath}`);
    }
    if (!statSync(targetPath).isDirectory()) {
      throw new BadRequestException(`Path is not a directory: ${targetPath}`);
    }

    const directories = readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

    const parentPath = dirname(targetPath);
    const parent = parentPath !== targetPath && this.isPathUnderRoots(parentPath, roots) ? parentPath : null;

    return { path: targetPath, parent, directories };
  }

  private getBrowseRoots(): string[] {
    const configured = (process.env.FILE_BROWSE_ROOTS ?? "").trim();
    if (configured) {
      return configured.split(",").map((item) => resolve(item.trim())).filter(Boolean);
    }
    if (process.platform === "win32") {
      return [resolve("C:\\")];
    }
    const home = homedir();
    return [resolve("/mnt/c"), resolve(home)].filter((item, index, arr) => arr.indexOf(item) === index);
  }

  private assertAllowedBrowsePath(rawPath: string, roots: string[]): string {
    const normalized = resolve(rawPath);
    if (!this.isPathUnderRoots(normalized, roots)) {
      throw new BadRequestException("Path is outside allowed browse roots");
    }
    return normalized;
  }

  private isPathUnderRoots(targetPath: string, roots: string[]): boolean {
    const normalized = resolve(targetPath);
    return roots.some((root) => {
      const normalizedRoot = resolve(root);
      return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}${sep}`);
    });
  }

  private normalizeFolderName(value: string): string {
    return value.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}
