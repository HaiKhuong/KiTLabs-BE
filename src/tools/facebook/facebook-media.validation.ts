import { BadRequestException } from "@nestjs/common";
import { lstatSync, realpathSync, statSync } from "fs";
import { basename, extname, isAbsolute, relative, resolve } from "path";

import { FacebookContentKind } from "./facebook.types";

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

export function validateFacebookMedia(
  sourcePath: string,
  kind: FacebookContentKind,
): { realPath: string; fileName: string; sizeBytes: number } {
  if (kind === FacebookContentKind.POST) {
    throw new BadRequestException("Bài viết chữ không cần tệp đính kèm");
  }
  if (!isAbsolute(sourcePath)) {
    throw new BadRequestException("Đường dẫn tệp không hợp lệ");
  }
  let realPath: string;
  let link: ReturnType<typeof lstatSync>;
  let file: ReturnType<typeof statSync>;
  try {
    realPath = realpathSync(sourcePath);
    link = lstatSync(sourcePath);
    file = statSync(realPath);
  } catch {
    throw new BadRequestException("Không tìm thấy tệp cục bộ");
  }
  if (link.isSymbolicLink() || !file.isFile()) {
    throw new BadRequestException("Tệp phải là file cục bộ thông thường");
  }
  const roots = (process.env.FACEBOOK_NATIVE_IMPORT_ROOTS ?? "")
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => realpathSync(resolve(item)));
  if (
    roots.length > 0 &&
    !roots.some((root) => {
      const rel = relative(root, realPath);
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
    })
  ) {
    throw new BadRequestException("Tệp không nằm trong vùng được phép");
  }
  const extension = extname(realPath).toLowerCase();
  const allowed = kind === FacebookContentKind.PHOTO ? PHOTO_EXTENSIONS : VIDEO_EXTENSIONS;
  if (!allowed.has(extension)) {
    throw new BadRequestException("Định dạng tệp không được hỗ trợ");
  }
  const maxBytes = Number(process.env.FACEBOOK_LOCAL_MAX_BYTES ?? 4_294_967_296);
  if (file.size <= 0 || file.size > maxBytes) {
    throw new BadRequestException("Kích thước tệp vượt giới hạn");
  }
  return { realPath, fileName: basename(realPath), sizeBytes: file.size };
}

export function assertHttpsUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new BadRequestException(`${label} không hợp lệ`);
  }
  if (url.protocol !== "https:") throw new BadRequestException(`${label} phải bắt đầu bằng https://`);
  return url.toString();
}
