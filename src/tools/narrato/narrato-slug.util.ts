import { basename } from "path";

export function toNarratoSnakeCaseSlug(name: string): string {
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
  return slug || "narrato";
}

export function slugFromVideoPath(videoPath: string): string {
  return toNarratoSnakeCaseSlug(basename(videoPath));
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
