import { Logger } from "@nestjs/common";
import { readFileSync } from "fs";
import { extname } from "path";

const MIME_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

const logger = new Logger("WhiteboardImage");

/** Resolve MIME from a source-image path (falls back to PNG). */
export function mimeFromPath(filePath: string): string {
  return MIME_MAP[extname(filePath).toLowerCase()] ?? "image/png";
}

/**
 * Read image dimensions from raw bytes without an external lib.
 * Supports PNG, JPEG, and lossy WebP. Falls back to 1280×720 if parsing fails.
 */
export function readImageDimensions(
  buf: Buffer,
  mimeType: string,
): { imageWidth: number; imageHeight: number } {
  try {
    if (mimeType === "image/png") {
      if (buf.length >= 24) {
        const width = buf.readUInt32BE(16);
        const height = buf.readUInt32BE(20);
        if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
      }
    } else if (mimeType === "image/jpeg" || mimeType === "image/jpg") {
      let i = 2;
      while (i < buf.length - 8) {
        if (buf[i] !== 0xff) break;
        const marker = buf[i + 1];
        const segLen = buf.readUInt16BE(i + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
          const height = buf.readUInt16BE(i + 5);
          const width = buf.readUInt16BE(i + 7);
          if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
        }
        i += 2 + segLen;
      }
    } else if (mimeType === "image/webp") {
      if (
        buf.length >= 30 &&
        buf.slice(0, 4).toString() === "RIFF" &&
        buf.slice(8, 12).toString() === "WEBP"
      ) {
        const width = (buf.readUInt16LE(26) & 0x3fff) + 1;
        const height = (buf.readUInt16LE(28) & 0x3fff) + 1;
        if (width > 0 && height > 0) return { imageWidth: width, imageHeight: height };
      }
    }
  } catch {
    // fall through
  }
  logger.warn("Could not parse image dimensions, defaulting to 1280x720");
  return { imageWidth: 1280, imageHeight: 720 };
}

export function readImageDimensionsFromPath(filePath: string): {
  imageWidth: number;
  imageHeight: number;
} {
  const mimeType = mimeFromPath(filePath);
  return readImageDimensions(readFileSync(filePath), mimeType);
}
