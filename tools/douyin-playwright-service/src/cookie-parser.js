function normalizeCookieContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (typeof content === "object" && typeof content.value === "string") {
    return content.value;
  }
  return String(content);
}

/**
 * Parse Netscape HTTP Cookie File format into Playwright cookie objects.
 * Supports yt-dlp `#HttpOnly_` prefix lines.
 */
function parseNetscapeCookies(content) {
  const normalizedContent = normalizeCookieContent(content);
  if (!normalizedContent) return [];

  const cookies = [];
  const normalized = normalizedContent.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (const line of normalized.split("\n")) {
    let trimmed = line.trim();
    if (!trimmed) continue;

    let httpOnly = false;
    if (trimmed.startsWith("#HttpOnly_")) {
      httpOnly = true;
      trimmed = trimmed.slice("#HttpOnly_".length);
    } else if (trimmed.startsWith("#")) {
      continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 7) continue;

    const [domain, , path, secure, expires, name, ...valueParts] = parts;
    const value = valueParts.join("\t");
    const expiresNum = parseInt(expires, 10);

    if (!name) continue;

    cookies.push({
      name,
      value,
      domain,
      path: path || "/",
      expires: Number.isFinite(expiresNum) && expiresNum > 0 ? expiresNum : undefined,
      httpOnly,
      secure: String(secure).toUpperCase() === "TRUE",
      sameSite: "Lax",
    });
  }

  return cookies;
}

module.exports = { parseNetscapeCookies };
