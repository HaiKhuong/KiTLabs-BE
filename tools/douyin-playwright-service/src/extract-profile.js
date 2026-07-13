const { DOUYIN_ORIGIN, mapAwemeToVideo, createDouyinPage } = require("./shared");

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
    throw new Error("Could not parse sec_user_id from profile URL");
  }

  return decodeURIComponent(match[1]);
}

function buildPostsApiUrl(secUserId, cursor) {
  return (
    `${DOUYIN_ORIGIN}/aweme/v1/web/aweme/post/` +
    `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
    `&sec_user_id=${encodeURIComponent(secUserId)}` +
    `&max_cursor=${cursor}`
  );
}

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_PAGES = 30;

  const { context, page } = await createDouyinPage(cookieContent);

  try {
    // Navigate to profile to warm up session
    console.log(`[profile] warming up: ${secUserId}`);
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    // Use Playwright's built-in HTTP client (context.request)
    // It sends cookies from context, handles compression, bypasses browser anti-bot
    const allAweme = [];
    const seenIds = new Set();
    let currentCursor = 0;

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      const apiUrl = buildPostsApiUrl(secUserId, currentCursor);
      console.log(`[profile] page ${pageNum + 1}: cursor=${currentCursor}`);

      const response = await context.request.get(apiUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "vi",
          referer: `${DOUYIN_ORIGIN}/user/${secUserId}`,
        },
        timeout: 30_000,
      });

      const text = await response.text();

      if (!text.trim()) {
        console.log(`[profile] page ${pageNum + 1}: empty response (HTTP ${response.status()})`);
        break;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        console.log(`[profile] page ${pageNum + 1}: invalid JSON, len=${text.length}`);
        console.log(`[profile] preview: ${text.slice(0, 200)}`);
        break;
      }

      const list = data.aweme_list || [];
      console.log(
        `[profile] page ${pageNum + 1}: aweme_list=${list.length}, ` +
        `has_more=${data.has_more}, max_cursor=${data.max_cursor}, ` +
        `status=${data.status_code}, keys=[${Object.keys(data).join(",")}]`,
      );

      if (list.length === 0) {
        console.log(`[profile] empty list, stopping. total=${allAweme.length}`);
        break;
      }

      for (const item of list) {
        const id = item.aweme_id || item.awemeId;
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          allAweme.push(item);
        }
      }

      const hasMore = data.has_more == 1 || data.has_more === true;
      const nextCursor = data.max_cursor;

      if (!hasMore) {
        console.log(`[profile] no more pages. total=${allAweme.length}`);
        break;
      }

      if (!nextCursor || nextCursor === currentCursor) {
        console.log(`[profile] cursor stuck. total=${allAweme.length}`);
        break;
      }

      currentCursor = nextCursor;
      await new Promise((r) => setTimeout(r, 800));
    }

    if (!allAweme.length) {
      throw new Error("No videos found in profile. Cookies may be required.");
    }

    const videos = allAweme
      .map(mapAwemeToVideo)
      .sort((a, b) => (b.create_time || 0) - (a.create_time || 0));

    const first = allAweme[0] || {};
    console.log(`[profile] done: ${videos.length} videos loaded`);

    return {
      uploader: first.author?.nickname || first.nickname || null,
      uploader_id: first.author?.sec_uid || secUserId,
      videos,
      has_more: false,
      next_cursor: 0,
      cursor: 0,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = { extractProfile, extractSecUserId };
