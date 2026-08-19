import { basename } from "path";

/** Video basename → snake_case folder slug (e.g. "My Movie.mp4" → "my_movie"). */
export function toVideoSnakeCaseSlug(name: string): string {
  const base = String(name || "")
    .trim()
    .replace(/\.[^.]+$/, "");
  const slug = base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return slug || "recap";
}

export function slugFromVideoPath(videoPath: string): string {
  return toVideoSnakeCaseSlug(basename(videoPath));
}

export function normalizeWorkDirSlug(raw: string): string {
  const slug = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return slug || "";
}
