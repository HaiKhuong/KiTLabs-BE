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

async function fetchPostsPage(page, secUserId, cursor, count = 20) {
  return page.evaluate(
    async ({ secUserId: userId, cursor: startCursor, count: perPage }) => {
      const apiUrl =
        `https://www.douyin.com/aweme/v1/web/aweme/post/` +
        `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
        `&sec_user_id=${encodeURIComponent(userId)}` +
        `&max_cursor=${startCursor}` +
        `&count=${perPage}`;

      const response = await fetch(apiUrl, {
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "vi",
        },
        credentials: "include",
        method: "GET",
        mode: "cors",
      });

      if (!response.ok) {
        throw new Error(`Douyin API returned HTTP ${response.status}`);
      }

      const data = await response.json();
      return {
        aweme_list: data?.aweme_list || [],
        has_more: data?.has_more ?? 0,
        max_cursor: data?.max_cursor ?? 0,
      };
    },
    { secUserId, cursor, count },
  );
}

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_PAGES = 50;

  const { context, page } = await createDouyinPage(cookieContent);

  try {
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(2_000);

    const allAweme = [];
    let currentCursor = 0;
    let hasMore = true;

    for (let pageNum = 0; pageNum < MAX_PAGES && hasMore; pageNum++) {
      const pageData = await fetchPostsPage(page, secUserId, currentCursor, 20);
      const list = pageData.aweme_list || [];

      if (list.length === 0) break;

      allAweme.push(...list);
      hasMore = !!pageData.has_more;
      currentCursor = pageData.max_cursor ?? 0;

      console.log(`[profile] page ${pageNum + 1}: +${list.length} videos, total=${allAweme.length}, hasMore=${hasMore}`);

      if (hasMore) {
        await page.waitForTimeout(500);
      }
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
