const {
  DOUYIN_ORIGIN,
  mapAwemeToVideo,
  parseAwemeIdFromUrl,
  createDouyinPage,
} = require("./shared");

function buildDetailApiUrl(awemeId) {
  return (
    `${DOUYIN_ORIGIN}/aweme/v1/web/aweme/detail/` +
    `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
    `&aweme_id=${encodeURIComponent(awemeId)}`
  );
}

async function resolveAwemeId(page, context, inputUrl) {
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

  const response = await context.request.get(inputUrl, {
    maxRedirects: 10,
    timeout: 30_000,
  });
  const finalUrl = response.url();
  const fromFinalUrl = parseAwemeIdFromUrl(finalUrl);
  if (fromFinalUrl) return fromFinalUrl;

  await page.goto(finalUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.waitForTimeout(1_500);

  const fromPage = await page.evaluate(() => {
    const href = window.location.href;
    const patterns = [
      /\/video\/(\d+)/i,
      /[?&]modal_id=(\d+)/i,
      /[?&]aweme_id=(\d+)/i,
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

async function fetchAwemeDetailViaRequest(context, awemeId, videoPageUrl) {
  const response = await context.request.get(buildDetailApiUrl(awemeId), {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "vi",
      referer: videoPageUrl,
    },
    timeout: 30_000,
  });

  const text = await response.text();
  if (!text.trim()) return null;

  try {
    const data = JSON.parse(text);
    return data?.aweme_detail || null;
  } catch {
    return null;
  }
}

async function fetchAwemeDetailFromBrowser(page, awemeId, videoPageUrl) {
  return page.evaluate(
    async ({ apiUrl, referer }) => {
      const response = await fetch(apiUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "vi",
          "sec-ch-ua":
            '"Not?A_Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        credentials: "include",
        method: "GET",
        mode: "cors",
        referrer: referer,
        referrerPolicy: "strict-origin-when-cross-origin",
      });

      const text = await response.text();
      if (!text.trim()) {
        return {
          error: `Douyin API returned empty body (HTTP ${response.status})`,
        };
      }

      try {
        const data = JSON.parse(text);
        return { detail: data?.aweme_detail || null };
      } catch {
        return { error: "Douyin API returned invalid JSON" };
      }
    },
    { apiUrl: buildDetailApiUrl(awemeId), referer: videoPageUrl },
  );
}

async function loadVideoDetail(page, context, awemeId) {
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

  try {
    await page.goto(videoPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(2_000);

    if (interceptedDetail) return interceptedDetail;

    const fromSsr = await parseAwemeDetailFromPage(page);
    if (fromSsr) return fromSsr;

    const fromRequest = await fetchAwemeDetailViaRequest(
      context,
      awemeId,
      videoPageUrl,
    );
    if (fromRequest) return fromRequest;

    const apiResult = await fetchAwemeDetailFromBrowser(
      page,
      awemeId,
      videoPageUrl,
    );
    if (apiResult?.detail) return apiResult.detail;
    if (apiResult?.error) {
      throw new Error(
        `${apiResult.error}. Pass cookie_content (Netscape format from cookies.txt).`,
      );
    }

    return null;
  } finally {
    page.off("response", onResponse);
  }
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
  const { context, page } = await createDouyinPage(cookieContent);

  try {
    const awemeId = await resolveAwemeId(page, context, url);
    const detail = await loadVideoDetail(page, context, awemeId);
    if (!detail) {
      throw new Error(
        "Could not extract video info. Pass cookie_content (Netscape format from cookies.txt).",
      );
    }

    return mapAwemeToExtractResponse(detail);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = {
  extractVideo,
  resolveAwemeId,
  loadVideoDetail,
  fetchAwemeDetail: loadVideoDetail,
};
