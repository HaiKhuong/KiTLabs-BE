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
  console.log(`[video] resolveAwemeId: ${inputUrl}`);

  const directId = parseAwemeIdFromUrl(inputUrl);
  if (directId) {
    console.log(`[video] direct parse: awemeId=${directId}`);
    return directId;
  }

  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    throw new Error("Invalid video URL");
  }

  if (!parsed.hostname.includes("douyin.com")) {
    throw new Error("URL must be a douyin.com video link");
  }

  console.log(`[video] following redirects...`);
  const response = await context.request.get(inputUrl, {
    maxRedirects: 10,
    timeout: 30_000,
  });
  const finalUrl = response.url();
  console.log(`[video] redirected to: ${finalUrl}`);

  const fromFinalUrl = parseAwemeIdFromUrl(finalUrl);
  if (fromFinalUrl) {
    console.log(`[video] from redirect URL: awemeId=${fromFinalUrl}`);
    return fromFinalUrl;
  }

  console.log(`[video] navigating to page to find awemeId...`);
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

  if (fromPage) {
    console.log(`[video] from page DOM: awemeId=${fromPage}`);
    return fromPage;
  }

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
        if (found) return { source: "RENDER_DATA", detail: found };
      } catch { /* ignore */ }
    }

    const globals = [
      { name: "__UNIVERSAL_DATA_FOR_REHYDRATION__", value: window.__UNIVERSAL_DATA_FOR_REHYDRATION__ },
      { name: "_SSR_HYDRATED_DATA", value: window._SSR_HYDRATED_DATA },
    ];
    for (const g of globals) {
      if (g.value) {
        const found = findAweme(g.value);
        if (found) return { source: g.name, detail: found };
      }
    }

    return null;
  });
}

async function fetchAwemeDetailViaRequest(context, awemeId, videoPageUrl) {
  const apiUrl = buildDetailApiUrl(awemeId);
  console.log(`[video] strategy 3: context.request.get ${apiUrl.slice(0, 80)}...`);

  const response = await context.request.get(apiUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "vi",
      referer: videoPageUrl,
    },
    timeout: 30_000,
  });

  const text = await response.text();
  console.log(`[video] strategy 3: HTTP ${response.status()}, body=${text.length} bytes`);

  if (!text.trim()) return null;

  try {
    const data = JSON.parse(text);
    if (data?.aweme_detail) {
      console.log(`[video] strategy 3: found aweme_detail`);
      return data.aweme_detail;
    }
    console.log(`[video] strategy 3: no aweme_detail, keys=[${Object.keys(data).join(",")}]`);
    return null;
  } catch {
    console.log(`[video] strategy 3: invalid JSON`);
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
          bodyLen: 0,
        };
      }

      try {
        const data = JSON.parse(text);
        if (data?.aweme_detail) {
          return { detail: data.aweme_detail };
        }
        return {
          error: `No aweme_detail in response`,
          keys: Object.keys(data),
          statusCode: data?.status_code,
          bodyLen: text.length,
        };
      } catch {
        return { error: "Douyin API returned invalid JSON", bodyLen: text.length };
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
        console.log(`[video] strategy 1 (intercept): found aweme_detail`);
      }
    } catch { /* ignore */ }
  };

  page.on("response", onResponse);

  try {
    console.log(`[video] navigating to: ${videoPageUrl}`);
    await page.goto(videoPageUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    const currentUrl = page.url();
    const title = await page.title();
    const bodyLen = await page.evaluate(() => document.body?.innerHTML?.length || 0);
    console.log(
      `[video] page loaded: title="${title}", url=${currentUrl}, bodyLen=${bodyLen}`,
    );

    // Check if redirected to login/captcha
    if (currentUrl.includes("/login") || currentUrl.includes("/verify")) {
      console.log(`[video] WARNING: redirected to login/verify page`);
    }

    // Strategy 1: intercepted from network
    if (interceptedDetail) {
      console.log(`[video] SUCCESS via strategy 1 (network intercept)`);
      return interceptedDetail;
    }
    console.log(`[video] strategy 1 (network intercept): no detail captured`);

    // Strategy 2: parse SSR/hydration data
    console.log(`[video] trying strategy 2 (SSR parse)...`);
    const ssrResult = await parseAwemeDetailFromPage(page);
    if (ssrResult?.detail) {
      console.log(`[video] SUCCESS via strategy 2 (SSR: ${ssrResult.source})`);
      return ssrResult.detail;
    }
    // Debug what data sources exist
    const ssrDebug = await page.evaluate(() => {
      return {
        hasRenderData: !!document.querySelector("script#RENDER_DATA"),
        renderDataLen: document.querySelector("script#RENDER_DATA")?.textContent?.length || 0,
        hasUniversal: !!window.__UNIVERSAL_DATA_FOR_REHYDRATION__,
        hasSsrHydrated: !!window._SSR_HYDRATED_DATA,
        scriptCount: document.querySelectorAll("script").length,
      };
    });
    console.log(
      `[video] strategy 2: no detail. RENDER_DATA=${ssrDebug.hasRenderData} (${ssrDebug.renderDataLen}b), ` +
      `UNIVERSAL=${ssrDebug.hasUniversal}, SSR_HYDRATED=${ssrDebug.hasSsrHydrated}, ` +
      `scripts=${ssrDebug.scriptCount}`,
    );

    // Strategy 3: context.request API call
    console.log(`[video] trying strategy 3 (context.request)...`);
    const fromRequest = await fetchAwemeDetailViaRequest(context, awemeId, videoPageUrl);
    if (fromRequest) {
      console.log(`[video] SUCCESS via strategy 3 (context.request)`);
      return fromRequest;
    }

    // Strategy 4: in-browser fetch
    console.log(`[video] trying strategy 4 (browser fetch)...`);
    const apiResult = await fetchAwemeDetailFromBrowser(page, awemeId, videoPageUrl);
    if (apiResult?.detail) {
      console.log(`[video] SUCCESS via strategy 4 (browser fetch)`);
      return apiResult.detail;
    }
    if (apiResult?.error) {
      console.log(
        `[video] strategy 4 FAILED: ${apiResult.error}, ` +
        `keys=${apiResult.keys || "N/A"}, status=${apiResult.statusCode || "N/A"}, ` +
        `bodyLen=${apiResult.bodyLen}`,
      );
    }

    console.log(`[video] ALL strategies failed`);
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
  console.log(`[video] extract start: url=${url}, hasCookies=${!!cookieContent}`);
  const { context, page } = await createDouyinPage(cookieContent);

  try {
    const awemeId = await resolveAwemeId(page, context, url);
    console.log(`[video] awemeId resolved: ${awemeId}`);

    const detail = await loadVideoDetail(page, context, awemeId);
    if (!detail) {
      throw new Error(
        "Could not extract video info. All 4 strategies failed. " +
        "Pass cookie_content (Netscape format from cookies.txt).",
      );
    }

    const result = mapAwemeToExtractResponse(detail);
    console.log(
      `[video] extract done: id=${result.id}, title="${(result.title || "").slice(0, 50)}", ` +
      `formats=${result.formats.length}, thumbnail=${!!result.thumbnail}`,
    );
    return result;
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
