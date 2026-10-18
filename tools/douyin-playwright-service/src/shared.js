const { chromium } = require("playwright");
const { parseNetscapeCookies } = require("./cookie-parser");

const DOUYIN_ORIGIN = "https://www.douyin.com";

let browserPromise = null;

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
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

async function createDouyinPage(cookieContent) {
  const browser = await getBrowser();
  const context = await browser.newContext({
    locale: "vi-VN",
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });

  const cookies = parseNetscapeCookies(cookieContent);
  const page = await context.newPage();

  // Hide webdriver flag
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  if (cookies.length > 0) {
    await context.addCookies(cookies);
    await page
      .goto(DOUYIN_ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch(() => {});
    await page.waitForTimeout(1_000);
  }

  return { context, page };
}

async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close().catch(() => {});
    browserPromise = null;
  }
}

module.exports = {
  DOUYIN_ORIGIN,
  getBrowser,
  normalizeUrl,
  extractFormats,
  mapAwemeToVideo,
  parseAwemeIdFromUrl,
  createDouyinPage,
  closeBrowser,
};
