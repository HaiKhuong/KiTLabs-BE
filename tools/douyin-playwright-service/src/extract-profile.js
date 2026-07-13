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

async function fetchPostsPage(page, secUserId, cursor) {
  return page.evaluate(
    async ({ secUserId: userId, cursor: startCursor }) => {
      const apiUrl =
        `https://www.douyin.com/aweme/v1/web/aweme/post/` +
        `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
        `&sec_user_id=${encodeURIComponent(userId)}` +
        `&max_cursor=${startCursor}`;

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
    { secUserId, cursor },
  );
}

async function extractProfile({ url, cookieContent, maxVideos = 20, cursor = 0 }) {
  const secUserId = extractSecUserId(url);
  const pageSize = Math.min(Math.max(Number(maxVideos) || 20, 1), 50);
  const startCursor = Number(cursor) || 0;

  const { context, page } = await createDouyinPage(cookieContent);

  try {
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(2_000);

    const pageData = await fetchPostsPage(page, secUserId, startCursor);
    const awemeList = (pageData.aweme_list || []).slice(0, pageSize);

    if (!awemeList.length && startCursor === 0) {
      throw new Error("No videos found in profile. Cookies may be required.");
    }

    const videos = awemeList.map(mapAwemeToVideo);
    const first = awemeList[0] || {};

    return {
      uploader: first.author?.nickname || first.nickname || null,
      uploader_id: first.author?.sec_uid || secUserId,
      videos,
      cursor: startCursor,
      next_cursor: pageData.max_cursor ?? 0,
      has_more: pageData.has_more === 1 && awemeList.length > 0,
    };
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

module.exports = { extractProfile, extractSecUserId };
