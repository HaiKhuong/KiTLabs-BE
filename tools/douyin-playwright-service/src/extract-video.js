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

  let finalUrl = inputUrl;
  try {
    const response = await context.request.get(inputUrl, {
      maxRedirects: 10,
      timeout: 10_000,
    });
    finalUrl = response.url();
    const fromFinalUrl = parseAwemeIdFromUrl(finalUrl);
    if (fromFinalUrl) return fromFinalUrl;
  } catch {
    // Browser navigation below is the fallback for transient redirect failures.
  }

  await page.goto(finalUrl, {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  await page.waitForTimeout(500);

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
    timeout: 8_000,
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
  let lastError = null;

  // Fast path: cookies are already installed in the context and the API often
  // succeeds without paying the cost of a full browser navigation.
  try {
    const direct = await fetchAwemeDetailViaRequest(context, awemeId, videoPageUrl);
    if (direct) return direct;
  } catch (error) {
    lastError = error;
  }

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
      timeout: 20_000,
    });

    await page.waitForTimeout(1_000);

    if (interceptedDetail) return interceptedDetail;

    const fromSsr = await parseAwemeDetailFromPage(page);
    if (fromSsr) return fromSsr;

    // Retry after navigation has warmed the Douyin session.
    try {
      const fromRequest = await fetchAwemeDetailViaRequest(
        context,
        awemeId,
        videoPageUrl,
      );
      if (fromRequest) return fromRequest;
    } catch (error) {
      lastError = error;
    }

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

    if (lastError) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Douyin detail request failed: ${detail}`);
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
  const maxAttempts = 2;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { context, page } = await createDouyinPage(cookieContent);
    try {
      const awemeId = await resolveAwemeId(page, context, url);
      const detail = await loadVideoDetail(page, context, awemeId);
      if (!detail) {
        throw new Error(
          "Douyin returned no video data. Cookies may be expired or the video is unavailable.",
        );
      }
      return mapAwemeToExtractResponse(detail);
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
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
