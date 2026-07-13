export type DouyinUrlType = "video" | "profile";

export function detectDouyinUrlType(url: string): DouyinUrlType {
  const trimmed = url.trim();
  if (!trimmed) return "video";

  try {
    const { pathname, hostname } = new URL(trimmed);
    if (/\/user\/|\/share\/user\//i.test(pathname)) {
      return "profile";
    }
    if (/^v\.douyin\.com$/i.test(hostname)) {
      return "video";
    }
    if (/\/video\/|\/note\/|\/share\/video\//i.test(pathname)) {
      return "video";
    }
    return "video";
  } catch {
    return "video";
  }
}
