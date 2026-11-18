function normalizeCookieContent(content) {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  if (typeof content === "object" && typeof content.value === "string") {
    return content.value.trim();
  }
  return String(content).trim();
}

function normalizeSameSite(raw, secure) {
  const val = String(raw || "").toLowerCase();
  if (val === "strict") return "Strict";
  if (val === "none" || val === "no_restriction") return secure ? "None" : "Lax";
  return "Lax";
}

function parseJsonCookies(trimmed) {
  try {
    const parsed = JSON.parse(trimmed);
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.cookies)
        ? parsed.cookies
        : null;
    if (!list) return null;

    const cookies = [];
    for (const item of list) {
      if (!item || !item.name) continue;
      const secure = Boolean(item.secure);
      const expiresNum = Number(item.expirationDate ?? item.expires);
      cookies.push({
        name: String(item.name),
        value: String(item.value ?? ""),
        domain: String(item.domain || ".douyin.com"),
        path: String(item.path || "/"),
        expires: Number.isFinite(expiresNum) && expiresNum > 0 ? expiresNum : undefined,
        httpOnly: Boolean(item.httpOnly),
        secure,
        sameSite: normalizeSameSite(item.sameSite, secure),
      });
    }
    return cookies;
  } catch {
    return null;
  }
}

function parseHeaderCookies(trimmed) {
  if (!trimmed.includes("=") || trimmed.includes("\t")) return [];
  const raw = trimmed.replace(/^cookie:\s*/i, "");
  const cookies = [];
  for (const part of raw.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = part.slice(0, eqIdx).trim();
    const value = part.slice(eqIdx + 1).trim();
    if (!name) continue;
    cookies.push({
      name,
      value,
      domain: ".douyin.com",
      path: "/",
      httpOnly: false,
      secure: true,
      sameSite: "Lax",
    });
  }
  return cookies;
}

/**
 * Parse Netscape HTTP Cookie File format (primary), JSON cookie array,
 * or raw Cookie header string into Playwright cookie objects.
 * Supports yt-dlp `#HttpOnly_` prefix lines.
 */
function parseNetscapeCookies(content) {
  const normalizedContent = normalizeCookieContent(content);
  if (!normalizedContent) return [];

  if (normalizedContent.startsWith("[") || normalizedContent.startsWith("{")) {
    const jsonCookies = parseJsonCookies(normalizedContent);
    if (jsonCookies) return jsonCookies;
  }

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
    const isSecure = String(secure).toUpperCase() === "TRUE";

    if (!name) continue;

    cookies.push({
      name,
      value,
      domain,
      path: path || "/",
      expires: Number.isFinite(expiresNum) && expiresNum > 0 ? expiresNum : undefined,
      httpOnly,
      secure: isSecure,
      sameSite: "Lax",
    });
  }

  if (cookies.length === 0 && !normalized.includes("\t")) {
    return parseHeaderCookies(normalizedContent);
  }

  return cookies;
}

function cookiesToHeaderString(content) {
  const cookies = parseNetscapeCookies(content);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

module.exports = { parseNetscapeCookies, cookiesToHeaderString };
