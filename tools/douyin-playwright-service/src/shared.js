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
    video?.cover?.url_list?.[0] ||
    video?.origin_cover?.url_list?.[0] ||
    video?.dynamic_cover?.url_list?.[0];
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

function extractFormats(video) {
  const formats = [];

  if (Array.isArray(video?.bit_rate)) {
    for (const br of video.bit_rate) {
      const playUrl = normalizeUrl(br?.play_addr?.url_list?.[0]);
      if (!playUrl) continue;

      const height = Number(br.height) || 0;
      const width = Number(br.width) || 0;

      formats.push({
        format_id: br.gear_name || `br_${height || formats.length}`,
        height: height || null,
        width: width || null,
        ext: "mp4",
        filesize: br?.play_addr?.data_size || null,
        play_url: playUrl,
      });
    }
  }

  const defaultUrl = normalizeUrl(video?.play_addr?.url_list?.[0]);
  if (defaultUrl) {
    const height = Number(video?.height) || 0;
    const width = Number(video?.width) || 0;
    const exists = formats.some((f) => f.height === height && height > 0);
    if (!exists) {
      formats.push({
        format_id: "default",
        height: height || null,
        width: width || null,
        ext: "mp4",
        filesize: video?.play_addr?.data_size || null,
        play_url: defaultUrl,
      });
    }
  }

  formats.sort((a, b) => (b.height || 0) - (a.height || 0));

  const seen = new Set();
  return formats.filter((f) => {
    const key = `${f.height}-${f.width}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
