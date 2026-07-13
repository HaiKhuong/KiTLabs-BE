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
          "sec-ch-ua":
            '"Not?A_Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": '"Windows"',
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-origin",
        },
        referrer: `https://www.douyin.com/user/${userId}`,
        referrerPolicy: "strict-origin-when-cross-origin",
        credentials: "include",
        method: "GET",
        mode: "cors",
      });

      if (!response.ok) {
        throw new Error(`Douyin API returned HTTP ${response.status}`);
      }

      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return {
          aweme_list: [],
          has_more: undefined,
          max_cursor: undefined,
          status_code: -1,
          raw_keys: [],
          raw_preview: text.slice(0, 500),
        };
      }
      return {
        aweme_list: data?.aweme_list || [],
        has_more: data?.has_more,
        max_cursor: data?.max_cursor,
        status_code: data?.status_code,
        raw_keys: Object.keys(data || {}),
        raw_preview: text.slice(0, 300),
      };
    },
    { secUserId, cursor },
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

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      const pageData = await fetchPostsPage(page, secUserId, currentCursor);
      const list = pageData.aweme_list || [];

      console.log(
        `[profile] page ${pageNum + 1}: cursor=${currentCursor}, ` +
        `aweme_list=${list.length}, has_more=${pageData.has_more} (type=${typeof pageData.has_more}), ` +
        `max_cursor=${pageData.max_cursor}, status_code=${pageData.status_code}, ` +
        `keys=[${(pageData.raw_keys || []).join(",")}]`,
      );
      if (list.length === 0) {
        console.log(`[profile] raw_preview: ${pageData.raw_preview || "N/A"}`);
      }

      if (list.length === 0) {
        console.log(`[profile] empty page, stopping`);
        break;
      }

      allAweme.push(...list);

      const nextCursor = pageData.max_cursor;
      const hasMore = pageData.has_more == 1 || pageData.has_more === true;

      if (!hasMore) {
        console.log(`[profile] has_more is falsy, stopping. total=${allAweme.length}`);
        break;
      }

      if (!nextCursor || nextCursor === currentCursor) {
        console.log(`[profile] cursor stuck (${nextCursor}), stopping. total=${allAweme.length}`);
        break;
      }

      currentCursor = nextCursor;
      await page.waitForTimeout(800);
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
