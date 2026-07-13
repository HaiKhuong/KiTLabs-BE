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
 * Extract all cookies from a Playwright browser context
 * (including dynamically set ones by Douyin's JS).
 */
async function extractAllCookies(context) {
  const cookies = await context.cookies("https://www.douyin.com");
  return cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/**
 * Fetch a page of posts using Node.js native fetch with browser cookies.
 * Bypasses Douyin's in-browser anti-bot since request comes from server.
 */
async function fetchPostsViaNode(cookieString, secUserId, cursor) {
  const apiUrl =
    `https://www.douyin.com/aweme/v1/web/aweme/post/` +
    `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
    `&sec_user_id=${encodeURIComponent(secUserId)}` +
    `&max_cursor=${cursor}`;

  const response = await fetch(apiUrl, {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "vi",
      cookie: cookieString,
      referer: `https://www.douyin.com/user/${secUserId}`,
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });

  if (!response.ok) {
    console.log(`[profile] node fetch HTTP ${response.status}`);
    return { aweme_list: [], has_more: 0, max_cursor: 0 };
  }

  const data = await response.json();
  return {
    aweme_list: data?.aweme_list || [],
    has_more: data?.has_more,
    max_cursor: data?.max_cursor,
    status_code: data?.status_code,
  };
}

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_PAGES = 30;

  // Create browser context to get full cookie set (including dynamic ones)
  const { context, page } = await createDouyinPage(cookieContent);

  try {
    // Navigate to profile to warm up session and let Douyin JS set cookies
    console.log(`[profile] warming up session for: ${secUserId}`);
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    // Extract all cookies (including ones set by Douyin's JS)
    const cookieString = await extractAllCookies(context);
    console.log(`[profile] extracted ${cookieString.split(";").length} cookies from browser`);

    // Close browser - we only needed it for cookies
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    // Now fetch ALL pages using Node.js native fetch
    const allAweme = [];
    const seenIds = new Set();
    let currentCursor = 0;

    for (let pageNum = 0; pageNum < MAX_PAGES; pageNum++) {
      console.log(`[profile] page ${pageNum + 1}: cursor=${currentCursor}`);

      const result = await fetchPostsViaNode(cookieString, secUserId, currentCursor);
      const list = result.aweme_list || [];

      console.log(
        `[profile] page ${pageNum + 1}: aweme_list=${list.length}, ` +
        `has_more=${result.has_more}, max_cursor=${result.max_cursor}`,
      );

      if (list.length === 0) {
        console.log(`[profile] empty page, stopping. total=${allAweme.length}`);
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
  } catch (err) {
    // Make sure browser is cleaned up even if we closed early
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    throw err;
  }
}

module.exports = { extractProfile, extractSecUserId };
