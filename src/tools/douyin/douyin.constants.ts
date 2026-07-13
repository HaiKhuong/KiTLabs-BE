export type DouyinExtractProvider = "playwright" | "ytdlp";

function parseProvider(raw: string | undefined, fallback: DouyinExtractProvider): DouyinExtractProvider {
  const value = (raw ?? fallback).trim().toLowerCase();
  if (value === "ytdlp" || value === "yt-dlp" || value === "yt_dlp") return "ytdlp";
  if (value === "playwright" || value === "pw") return "playwright";
  return fallback;
}

const defaultProvider = parseProvider(process.env.DOUYIN_EXTRACT_PROVIDER, "playwright");

export const DOUYIN_VIDEO_EXTRACT_PROVIDER = parseProvider(
  process.env.DOUYIN_VIDEO_EXTRACT_PROVIDER,
  defaultProvider,
);

export const DOUYIN_PROFILE_EXTRACT_PROVIDER = parseProvider(
  process.env.DOUYIN_PROFILE_EXTRACT_PROVIDER,
  defaultProvider,
);

export const YTDLP_SERVICE_URL = process.env.YTDLP_SERVICE_URL ?? "http://localhost:8100";
export const DOUYIN_PLAYWRIGHT_SERVICE_URL =
  process.env.DOUYIN_PLAYWRIGHT_SERVICE_URL ?? "http://localhost:8101";

export const DOUYIN_COOKIE_FILE =
  process.env.DOUYIN_COOKIE_FILE ?? "secrets/douyin-cookies.txt";
