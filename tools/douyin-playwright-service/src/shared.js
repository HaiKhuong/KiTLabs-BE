const crypto = require("crypto");
const { chromium } = require("playwright");
const { parseNetscapeCookies } = require("./cookie-parser");

const DOUYIN_ORIGIN = "https://www.douyin.com";
const DESKTOP_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

const CONTEXT_TTL_MS = 15 * 60 * 1000;

let browserPromise = null;
const contextCache = new Map();

async function getBrowser() {
  if (browserPromise) {
    try {
      const existing = await browserPromise;
      if (existing.isConnected()) return existing;
    } catch {
      // relaunch below
    }
    browserPromise = null;
  }

  browserPromise = chromium
    .launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-dev-shm-usage",
      ],
    })
    .then((browser) => {
      browser.on("disconnected", () => {
        browserPromise = null;
        contextCache.clear();
      });
      return browser;
    })
    .catch((err) => {
      browserPromise = null;
      throw err;
    });

  return browserPromise;
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("http://")) return url.replace("http://", "https://");
  return url;
}

function pickThumbnail(video) {
  const cover =
    video?.dynamic_cover?.url_list?.[0] ||
    video?.cover?.url_list?.[0] ||
    video?.origin_cover?.url_list?.[0];
  return normalizeUrl(cover);
}

function pickBestHeight(video) {
  const formats = extractFormats(video);
  if (formats.length > 0) return formats[0].height || 0;
  if (video?.height) return video.height;
  return 0;
}

function normalizeDuration(raw) {
  if (raw == null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value > 1000 ? Math.round(value / 1000) : Math.round(value);
}

function uniqueFormatId(gearName, item, usedIds) {
  const base = gearName || `br_${item.height || 0}`;
  if (!usedIds.has(base)) {
    usedIds.add(base);
    return base;
  }

  const withMeta = `${base}_${item.height || 0}_${item.fps || 0}`;
  if (!usedIds.has(withMeta)) {
    usedIds.add(withMeta);
    return withMeta;
  }

  let index = 2;
  let next = `${withMeta}_${index}`;
  while (usedIds.has(next)) {
    index += 1;
    next = `${withMeta}_${index}`;
  }
  usedIds.add(next);
  return next;
}

function extractFormats(video) {
  const candidates = [];

  if (Array.isArray(video?.bit_rate)) {
    for (const br of video.bit_rate) {
      if (String(br?.format || "").toLowerCase() !== "mp4") continue;

      const play = br.play_addr;
      const playUrl = normalizeUrl(play?.url_list?.[0]);
      if (!playUrl) continue;

      const height = Number(play?.height) || 0;
      const width = Number(play?.width) || 0;
      const fps = Number(br.FPS) || 0;
      const filesize = Number(play?.data_size) || 0;

      candidates.push({
        gearName: br.gear_name ? String(br.gear_name) : "",
        height: height || null,
        width: width || null,
        ext: "mp4",
        filesize: filesize || null,
        fps: fps || null,
        play_url: playUrl,
      });
    }
  }

  if (candidates.length === 0 && video?.play_addr?.url_list?.length) {
    const rawPlay = normalizeUrl(video.play_addr.url_list[0]);
    if (rawPlay) {
      const noWmUrl = rawPlay.replace("/playwm/", "/play/");
      candidates.push({
        gearName: "default",
        height: Number(video?.play_addr?.height || video?.height) || null,
        width: Number(video?.play_addr?.width || video?.width) || null,
        ext: "mp4",
        filesize: Number(video?.play_addr?.data_size) || null,
        fps: null,
        play_url: noWmUrl,
      });
    }
  }

  const bestByKey = new Map();
  for (const item of candidates) {
    const key = [item.fps || 0, item.height || 0, item.width || 0, item.gearName].join("|");
    const current = bestByKey.get(key);
    if (!current || (item.filesize || 0) > (current.filesize || 0)) {
      bestByKey.set(key, item);
    }
  }

  const sorted = [...bestByKey.values()].sort((a, b) => {
    const heightDiff = (b.height || 0) - (a.height || 0);
    if (heightDiff !== 0) return heightDiff;
    return (b.fps || 0) - (a.fps || 0);
  });

  const usedIds = new Set();
  return sorted.map((item) => ({
    format_id: uniqueFormatId(item.gearName, item, usedIds),
    height: item.height,
    width: item.width,
    ext: item.ext,
    filesize: item.filesize,
    fps: item.fps,
    play_url: item.play_url,
  }));
}

function mapAwemeToVideo(entry) {
  const awemeId = String(entry.aweme_id || entry.awemeId || "");
  const video = entry.video || {};
  const desc = (entry.desc || entry.title || "").trim();
  const formats = extractFormats(video);

  return {
    id: awemeId,
    title: desc || `Video ${awemeId}`,
    thumbnail: pickThumbnail(video),
    duration: normalizeDuration(video.duration),
    best_height: pickBestHeight(video),
    webpage_url: awemeId ? `${DOUYIN_ORIGIN}/video/${awemeId}` : null,
    create_time: entry.create_time || null,
    play_url: formats[0]?.play_url || normalizeUrl(video?.play_addr?.url_list?.[0]),
    formats,
  };
}

function parseAwemeIdFromUrl(url) {
  if (!url) return null;

  const patterns = [
    /\/video\/(\d+)/i,
    /[?&]modal_id=(\d+)/i,
    /[?&]aweme_id=(\d+)/i,
    /\/share\/video\/(\d+)/i,
    /\/note\/(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
}

function hashCookieContent(cookieContent) {
  return crypto
    .createHash("sha256")
    .update(String(cookieContent || ""))
    .digest("hex")
    .slice(0, 16);
}

async function getOrCreateContext(cookieContent) {
  const key = hashCookieContent(cookieContent);
  const cached = contextCache.get(key);
  if (cached && Date.now() - cached.createdAt < CONTEXT_TTL_MS) {
    try {
      // Probe context liveness
      cached.context.pages();
      return { context: cached.context, cacheKey: key };
    } catch {
      contextCache.delete(key);
    }
  } else if (cached) {
    contextCache.delete(key);
    await cached.context.close().catch(() => {});
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "zh-CN",
    viewport: { width: 1920, height: 1080 },
    userAgent: DESKTOP_USER_AGENT,
    extraHTTPHeaders: {
      "Accept-Language": "zh-CN,zh;q=0.9,vi;q=0.8,en;q=0.7",
    },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
  });

  const cookies = parseNetscapeCookies(cookieContent);
  if (cookies.length > 0) {
    await context.addCookies(cookies);
  }

  // Keep cache bounded
  if (contextCache.size >= 5) {
    const oldestKey = contextCache.keys().next().value;
    const oldest = contextCache.get(oldestKey);
    contextCache.delete(oldestKey);
    if (oldest) await oldest.context.close().catch(() => {});
  }

  contextCache.set(key, { context, createdAt: Date.now(), warmPage: null });
  return { context, cacheKey: key };
}

async function attachLightweightRoute(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "media" || type === "image" || type === "font") {
      return route.abort();
    }
    return route.continue();
  });
}

function getWarmDouyinPage(cookieContent) {
  const key = hashCookieContent(cookieContent);
  const cached = contextCache.get(key);
  if (!cached || Date.now() - cached.createdAt >= CONTEXT_TTL_MS) return null;
  const page = cached.warmPage;
  if (!page || page.isClosed()) {
    cached.warmPage = null;
    return null;
  }
  try {
    if (page.url().includes("douyin.com")) {
      return { context: cached.context, page };
    }
  } catch {
    cached.warmPage = null;
  }
  return null;
}

function setWarmDouyinPage(cookieContent, page) {
  const key = hashCookieContent(cookieContent);
  const cached = contextCache.get(key);
  if (!cached || !page || page.isClosed()) return;
  if (cached.warmPage && cached.warmPage !== page && !cached.warmPage.isClosed()) {
    cached.warmPage.close().catch(() => {});
  }
  cached.warmPage = page;
}

async function createDouyinPage(cookieContent, { lightweight = false } = {}) {
  const { context, cacheKey } = await getOrCreateContext(cookieContent);
  const page = await context.newPage();
  if (lightweight) {
    await attachLightweightRoute(page);
  }
  return { context, page, cacheKey };
}

async function releaseDouyinPage(page, cookieContent) {
  if (!page) return;
  if (cookieContent !== undefined) {
    const key = hashCookieContent(cookieContent);
    const cached = contextCache.get(key);
    if (cached && cached.warmPage === page) {
      return;
    }
  }
  await page.close().catch(() => {});
}

async function invalidateDouyinContext(cookieContent) {
  const key = hashCookieContent(cookieContent);
  const cached = contextCache.get(key);
  if (cached) {
    contextCache.delete(key);
    await cached.context.close().catch(() => {});
  }
}

async function closeBrowser() {
  for (const [, entry] of contextCache) {
    await entry.context.close().catch(() => {});
  }
  contextCache.clear();
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = {
  DOUYIN_ORIGIN,
  DESKTOP_USER_AGENT,
  MOBILE_USER_AGENT,
  getBrowser,
  normalizeUrl,
  extractFormats,
  mapAwemeToVideo,
  parseAwemeIdFromUrl,
  attachLightweightRoute,
  getWarmDouyinPage,
  setWarmDouyinPage,
  createDouyinPage,
  releaseDouyinPage,
  invalidateDouyinContext,
  closeBrowser,
};
