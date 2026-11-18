const {
  DOUYIN_ORIGIN,
  MOBILE_USER_AGENT,
  mapAwemeToVideo,
  parseAwemeIdFromUrl,
  getWarmDouyinPage,
  setWarmDouyinPage,
  createDouyinPage,
  releaseDouyinPage,
  invalidateDouyinContext,
} = require("./shared");
const { cookiesToHeaderString } = require("./cookie-parser");

function buildDetailApiPath(awemeId) {
  return (
    `/aweme/v1/web/aweme/detail/` +
    `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
    `&aweme_id=${encodeURIComponent(awemeId)}` +
    `&update_version_code=170400&pc_client_type=1&version_code=190500` +
    `&version_name=19.5.0&cookie_enabled=true&platform=PC&downlink=10`
  );
}

async function fetchDetailViaWarmPage(page, awemeId) {
  try {
    const result = await page.evaluate(async (apiPath) => {
      try {
        const res = await fetch(apiPath, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "application/json, text/plain, */*",
          },
        });
        const text = await res.text();
        if (!text || !text.trim()) return null;
        const data = JSON.parse(text);
        return data?.aweme_detail || null;
      } catch {
        return null;
      }
    }, buildDetailApiPath(awemeId));
    return result || null;
  } catch {
    return null;
  }
}

async function resolveRedirectCleanly(inputUrl) {
  let current = inputUrl;
  for (let hop = 0; hop < 6; hop++) {
    const direct = parseAwemeIdFromUrl(current);
    if (direct) return direct;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        },
      });
      const location = res.headers.get("location");
      if (location && res.status >= 300 && res.status < 400) {
        current = new URL(location, current).toString();
        const fromLoc = parseAwemeIdFromUrl(current);
        if (fromLoc) return fromLoc;
        continue;
      }
      break;
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function resolveAwemeId(page, _context, inputUrl) {
  const directId = parseAwemeIdFromUrl(inputUrl);
  if (directId) return directId;

  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error("Invalid video URL");
  }

  if (!parsed.hostname.includes("douyin.com")) {
    throw new Error("URL must be a douyin.com video link");
  }

  const cleanResolved = await resolveRedirectCleanly(inputUrl);
  if (cleanResolved) return cleanResolved;

  await page.goto(inputUrl, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.waitForTimeout(800);

  const fromPage = await page.evaluate(() => {
    const href = window.location.href;
    const patterns = [
      /\/video\/(\d+)/i,
      /[?&]modal_id=(\d+)/i,
      /[?&]aweme_id=(\d+)/i,
      /\/share\/video\/(\d+)/i,
      /\/note\/(\d+)/i,
    ];

    for (const pattern of patterns) {
      const match = href.match(pattern);
      if (match?.[1]) return match[1];
    }

    const html = document.documentElement.innerHTML;
    const htmlPatterns = [
      /"awemeId":"(\d+)"/,
      /"aweme_id":"(\d+)"/,
      /"itemId":"(\d+)"/,
    ];

    for (const pattern of htmlPatterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1];
    }

    return null;
  });

  if (fromPage) return fromPage;

  throw new Error("Could not resolve aweme_id from URL");
}

async function parseAwemeDetailFromPage(page) {
  return page.evaluate(() => {
    function isAwemeEntry(obj) {
      if (!obj || typeof obj !== "object") return false;
      const id = obj.aweme_id ?? obj.awemeId;
      const video = obj.video;
      if (!id || !video || typeof video !== "object") return false;
      return !!(
        video.play_addr ||
        video.download_addr ||
        (Array.isArray(video.bit_rate) && video.bit_rate.length > 0)
      );
    }

    function findAweme(obj, depth = 0) {
      if (!obj || typeof obj !== "object" || depth > 16) return null;
      if (obj.aweme_detail && isAwemeEntry(obj.aweme_detail)) return obj.aweme_detail;
      if (isAwemeEntry(obj)) return obj;

      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") {
          const found = findAweme(value, depth + 1);
          if (found) return found;
        }
      }

      return null;
    }

    const renderScript = document.querySelector("script#RENDER_DATA");
    if (renderScript?.textContent) {
      try {
        const data = JSON.parse(decodeURIComponent(renderScript.textContent));
        const found = findAweme(data);
        if (found) return found;
      } catch {
        // ignore
      }
    }

    const globals = [
      window.__UNIVERSAL_DATA_FOR_REHYDRATION__,
      window._SSR_HYDRATED_DATA,
      window._ROUTER_DATA,
    ];
    for (const value of globals) {
      if (value) {
        const found = findAweme(value);
        if (found) return found;
      }
    }

    return null;
  });
}

async function detectPageBlockReason(page) {
  return page
    .evaluate(() => {
      const title = document.title || "";
      const text = document.body?.innerText || "";
      const combined = `${title} ${text.slice(0, 800)}`;
      if (/验证码|滑动验证|安全验证|verifycenter|captcha/i.test(combined)) {
        return "captcha";
      }
      if (/登录|扫码登录/i.test(title) && !document.querySelector("video")) {
        return "login";
      }
      return null;
    })
    .catch(() => null);
}

function findAwemeInObject(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 14) return null;
  if (
    (obj.aweme_id || obj.awemeId) &&
    obj.video &&
    typeof obj.video === "object" &&
    (obj.video.play_addr || (Array.isArray(obj.video.bit_rate) && obj.video.bit_rate.length > 0))
  ) {
    return obj;
  }
  if (Array.isArray(obj.item_list) && obj.item_list.length > 0) {
    const found = findAwemeInObject(obj.item_list[0], depth + 1);
    if (found) return found;
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === "object") {
      const found = findAwemeInObject(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function fetchIesDouyinShareDetail(awemeId, cookieContent) {
  const shareUrl = `https://www.iesdouyin.com/share/video/${awemeId}/`;
  const headers = {
    "User-Agent": MOBILE_USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    Referer: "https://www.iesdouyin.com/",
  };
  const cookieHeader = cookiesToHeaderString(cookieContent);
  if (cookieHeader) {
    headers.Cookie = cookieHeader;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch(shareUrl, {
      headers,
      redirect: "follow",
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/window\._ROUTER_DATA\s*=\s*({.+?})\s*<\/script>/s);
    if (!match?.[1]) return null;
    const routerData = JSON.parse(match[1]);
    return findAwemeInObject(routerData);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadVideoDetail(page, awemeId, cookieContent, { isWarmPage = false } = {}) {
  if (isWarmPage) {
    const direct = await fetchDetailViaWarmPage(page, awemeId);
    if (direct) return direct;
  }

  const videoPageUrl = `${DOUYIN_ORIGIN}/video/${awemeId}`;
  let interceptedDetail = null;

  const onResponse = async (response) => {
    if (!response.url().includes("/aweme/v1/web/aweme/detail")) return;
    try {
      const text = await response.text();
      if (!text.trim()) return;
      const data = JSON.parse(text);
      if (data?.aweme_detail) {
        interceptedDetail = data.aweme_detail;
      }
    } catch {
      // ignore
    }
  };

  page.on("response", onResponse);

  let blockReason = null;
  let triedBrowserFetch = false;
  try {
    await page.goto(videoPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });

    // Wait up to 8s for intercepted detail API, SSR data, or bdms-signed fetch
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (interceptedDetail) {
        setWarmDouyinPage(cookieContent, page);
        return interceptedDetail;
      }

      const fromSsr = await parseAwemeDetailFromPage(page);
      if (fromSsr) {
        setWarmDouyinPage(cookieContent, page);
        return fromSsr;
      }

      blockReason = await detectPageBlockReason(page);
      if (blockReason === "captcha") break;

      if (!triedBrowserFetch && Date.now() > deadline - 5_500) {
        const bdmsReady = await page
          .evaluate(() => Boolean(window.bdms || window.byted_acrawler))
          .catch(() => false);
        if (bdmsReady) {
          triedBrowserFetch = true;
          const fetched = await fetchDetailViaWarmPage(page, awemeId);
          if (fetched) {
            setWarmDouyinPage(cookieContent, page);
            return fetched;
          }
        }
      }

      await page.waitForTimeout(400);
    }

    if (interceptedDetail) {
      setWarmDouyinPage(cookieContent, page);
      return interceptedDetail;
    }

    if (!triedBrowserFetch && blockReason !== "captcha") {
      const fetched = await fetchDetailViaWarmPage(page, awemeId);
      if (fetched) {
        setWarmDouyinPage(cookieContent, page);
        return fetched;
      }
    }
  } catch {
    // Fallback to iesdouyin share page below
  } finally {
    page.off("response", onResponse);
  }

  // Strategy 2: iesdouyin.com mobile share SSR (does not require a_bogus)
  const shareDetail = await fetchIesDouyinShareDetail(awemeId, cookieContent);
  if (shareDetail) return shareDetail;

  if (blockReason === "captcha") {
    throw new Error(
      "Douyin triggered captcha verification (CAPTCHA_REQUIRED). Please refresh cookies in a real browser.",
    );
  }

  return null;
}

function mapAwemeToExtractResponse(entry) {
  const mapped = mapAwemeToVideo(entry);
  const author = entry.author || {};

  return {
    id: mapped.id,
    title: mapped.title,
    thumbnail: mapped.thumbnail,
    duration: mapped.duration,
    uploader: author.nickname || entry.nickname || null,
    uploader_id: author.sec_uid || (author.uid != null ? String(author.uid) : null),
    webpage_url: mapped.webpage_url,
    formats: mapped.formats,
  };
}

async function extractVideo({ url, cookieContent }) {
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const warm = attempt === 1 ? getWarmDouyinPage(cookieContent) : null;
    const isWarmPage = Boolean(warm);
    const { context, page } = warm || (await createDouyinPage(cookieContent, { lightweight: true }));
    try {
      const awemeId = await resolveAwemeId(page, context, url);
      const detail = await loadVideoDetail(page, awemeId, cookieContent, { isWarmPage });
      if (!detail) {
        throw new Error(
          "Douyin returned no video data. Cookies may be expired or the video is unavailable.",
        );
      }
      return mapAwemeToExtractResponse(detail);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await invalidateDouyinContext(cookieContent);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    } finally {
      await releaseDouyinPage(page, cookieContent);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "Unknown upstream error";
  throw new Error(`Unable to extract this Douyin video after ${maxAttempts} attempts: ${detail}`);
}

module.exports = {
  extractVideo,
  resolveAwemeId,
  loadVideoDetail,
  fetchAwemeDetail: loadVideoDetail,
};
