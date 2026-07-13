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

/**
 * Fetch one page of videos using a FRESH browser context.
 * Each context gets fresh anti-bot tokens from Douyin.
 */
async function fetchOnePage(cookieContent, secUserId, cursor) {
  const { context, page } = await createDouyinPage(cookieContent);

  try {
    // Navigate to profile page to warm up session + get anti-bot tokens
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(2_000);

    // Make the API call from within the page context
    const result = await page.evaluate(
      async ({ userId, startCursor }) => {
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
          return { error: `HTTP ${response.status}`, aweme_list: [] };
        }

        const data = await response.json();
        return {
          aweme_list: data?.aweme_list || [],
          has_more: data?.has_more,
          max_cursor: data?.max_cursor,
          status_code: data?.status_code,
        };
      },
      { userId: secUserId, startCursor: cursor },
    );

    return result;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_PAGES = 20;
  const EMPTY_RETRY = 2;

  const allAweme = [];
  const seenIds = new Set();
  let currentCursor = 0;

  for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
    console.log(`[profile] page ${pageNum + 1}: fetching with cursor=${currentCursor} (fresh context)`);

    let result;
    let emptyRetries = 0;

    // Retry with fresh context if we get empty response
    while (emptyRetries <= EMPTY_RETRY) {
      result = await fetchOnePage(cookieContent, secUserId, currentCursor);

      const list = result.aweme_list || [];
      console.log(
        `[profile] page ${pageNum + 1} attempt ${emptyRetries + 1}: ` +
        `aweme_list=${list.length}, has_more=${result.has_more}, ` +
        `max_cursor=${result.max_cursor}, status_code=${result.status_code}`,
      );

      if (list.length > 0 || !result.has_more) break;

      emptyRetries++;
      if (emptyRetries <= EMPTY_RETRY) {
        console.log(`[profile] empty response, retrying with fresh context...`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const list = result.aweme_list || [];
    if (list.length === 0) {
      console.log(`[profile] no videos returned, stopping. total=${allAweme.length}`);
      break;
    }

    for (const item of list) {
      const id = item.aweme_id || item.awemeId;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        allAweme.push(item);
      }
    }

    const hasMore = result.has_more == 1 || result.has_more === true;
    const nextCursor = result.max_cursor;

    if (!hasMore) {
      console.log(`[profile] has_more is falsy, stopping. total=${allAweme.length}`);
      break;
    }

    if (!nextCursor || nextCursor === currentCursor) {
      console.log(`[profile] cursor stuck, stopping. total=${allAweme.length}`);
      break;
    }

    currentCursor = nextCursor;
    // Small delay between pages
    await new Promise((r) => setTimeout(r, 500));
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
}

module.exports = { extractProfile, extractSecUserId };
