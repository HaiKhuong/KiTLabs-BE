import { join, resolve } from "path";

import { AUDIO_DATA_ROOT } from "../audio/audio.constants";

export const VIDEO_IMAGES_OUTPUT_DIR = join(AUDIO_DATA_ROOT, "video-images");

export const FLUX_SCHNELL_MODEL_ID = "black-forest-labs/FLUX.1-schnell";

export function resolveVideoImagesOutputDir(): string {
  const raw = (process.env.VIDEO_IMAGES_DATA_ROOT ?? process.env.IMAGE_DATA_ROOT ?? "").trim();
  if (raw) {
    return resolve(raw);
  }
  return resolve(VIDEO_IMAGES_OUTPUT_DIR);
}

export function buildSceneImageFilename(sceneNumber: number): string {
  return `scene-${sceneNumber}.png`;
}

export function buildSceneImageRelativeUrl(
  userId: string,
  nodeId: string,
  sceneNumber: number,
): string {
  const filename = buildSceneImageFilename(sceneNumber);
  return `/api/tools/videos/images/${encodeURIComponent(userId)}/${encodeURIComponent(nodeId)}/${filename}`;
}

export const STUDIO_IMAGE_FILENAME = "output.png";

export function buildStudioImageRelativeUrl(userId: string, jobId: string): string {
  return `/api/tools/images/${encodeURIComponent(userId)}/${encodeURIComponent(jobId)}/${STUDIO_IMAGE_FILENAME}`;
}
