const {
  DOUYIN_ORIGIN,
  mapAwemeToVideo,
  createDouyinPage,
  releaseDouyinPage,
} = require("./shared");

function extractSecUserId(profileUrl) {
  let parsed;
  try {
    parsed = new URL(profileUrl);
  } catch {
    throw new Error("Invalid profile URL");
  }

  if (!parsed.hostname.includes("douyin.com")) {
    throw new Error("URL must be a douyin.com profile link");
  }

  const match = parsed.pathname.match(/\/user\/([^/]+)/i);
  if (!match?.[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

async function resolveSecUserId(context, profileUrl) {
  const direct = extractSecUserId(profileUrl);
  if (direct) return direct;

  try {
    const response = await context.request.get(profileUrl, {
      maxRedirects: 10,
      timeout: 10_000,
    });
    const resolved = extractSecUserId(response.url());
    if (resolved) return resolved;
  } catch {
    // ignore
  }

  throw new Error("Could not parse sec_user_id from profile URL");
}

async function extractProfile({ url, cookieContent, maxVideos = 20, cursor = 0 }) {
  const limit = Math.max(1, Math.min(Number(maxVideos) || 20, 50));
  const { context, page } = await createDouyinPage(cookieContent);

  try {
    const secUserId = await resolveSecUserId(context, url);
    const allAweme = [];
    const seenIds = new Set();
    let hasMore = false;
    let nextCursor = cursor || 0;

    const onResponse = async (response) => {
      if (!response.url().includes("/aweme/v1/web/aweme/post")) return;
      try {
        const text = await response.text();
        if (!text.trim()) return;
        const data = JSON.parse(text);
        const list = Array.isArray(data?.aweme_list) ? data.aweme_list : [];
        for (const item of list) {
          const id = item.aweme_id || item.awemeId;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            allAweme.push(item);
          }
        }
        hasMore = data.has_more == 1 || data.has_more === true;
        if (data.max_cursor) {
          nextCursor = Number(data.max_cursor) || nextCursor;
        }
      } catch {
        // ignore
      }
    };

    page.on("response", onResponse);

    try {
      await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });

      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline && allAweme.length === 0) {
        await page.waitForTimeout(500);
      }

      // Scroll to load more if needed up to limit
      let scrollRounds = 0;
      while (allAweme.length < limit && hasMore && scrollRounds < 6) {
        const prevCount = allAweme.length;
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1_500);
        if (allAweme.length === prevCount) break;
        scrollRounds += 1;
      }
    } finally {
      page.off("response", onResponse);
    }

    if (!allAweme.length) {
      throw new Error("No videos found in profile. Cookies may be required.");
    }

    const sliced = allAweme.slice(0, limit);
    const videos = sliced
      .map(mapAwemeToVideo)
      .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));

    const first = sliced[0] || {};
    return {
      uploader: first.author?.nickname || first.nickname || null,
      uploader_id: first.author?.sec_uid || secUserId,
      videos,
      has_more: hasMore || allAweme.length > limit,
      next_cursor: nextCursor,
      cursor,
    };
  } finally {
    await releaseDouyinPage(page);
  }
}

module.exports = { extractProfile, extractSecUserId };
