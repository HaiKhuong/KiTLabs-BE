import { join } from "path";

import { resolveConfiguredPath } from "../../common/desktop/data-path";

export const IMAGE_EDIT_QUEUE_NAME = "image-edit";

export const IMAGE_EDIT_FEATURES = ["cutout", "remove-bg", "detect", "upscale"] as const;

export type ImageEditFeature = (typeof IMAGE_EDIT_FEATURES)[number];

export const IMAGE_EDIT_SCALES = [2, 4] as const;

export type ImageEditScale = (typeof IMAGE_EDIT_SCALES)[number];

export const IMAGE_EDIT_DOMAINS = ["photo", "anime"] as const;

export type ImageEditDomain = (typeof IMAGE_EDIT_DOMAINS)[number];

export const IMAGE_EDIT_MAX_UPLOAD_BYTES = 25_000_000;

export const IMAGE_EDIT_ALLOWED_EXT = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function resolveImageEditRoot(): string {
  return resolveConfiguredPath(process.env.IMAGE_EDIT_WORK_ROOT, "image-edit");
}

export function resolveImageEditModelsDir(): string {
  return resolveConfiguredPath(process.env.IMAGE_EDIT_MODELS_DIR, "models/image-edit");
}

export function imageEditJobDir(feature: ImageEditFeature, userId: string, jobId: string): string {
  return join(resolveImageEditRoot(), feature, userId, jobId);
}

export function imageEditScriptPath(): string {
  return join(process.cwd(), "tools", "image-pipeline", "image_edit.py");
}
