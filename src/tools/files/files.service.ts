import { Injectable } from "@nestjs/common";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

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

  private normalizeFolderName(value: string): string {
    return value.replace(/[^a-zA-Z0-9-_]/g, "_");
  }
}
