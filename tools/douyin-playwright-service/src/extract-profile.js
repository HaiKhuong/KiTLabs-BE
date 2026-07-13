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

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_SCROLL_ROUNDS = 60;
  const SCROLL_PAUSE = 1500;
  const STALE_LIMIT = 5;

  const { context, page } = await createDouyinPage(cookieContent);

  try {
    const allAweme = [];
    const seenIds = new Set();

    page.on("response", async (response) => {
      if (!response.url().includes("/aweme/v1/web/aweme/post")) return;
      try {
        const json = await response.json();
        const list = json?.aweme_list;
        if (!Array.isArray(list)) return;

        for (const item of list) {
          const id = item.aweme_id || item.awemeId;
          if (id && !seenIds.has(id)) {
            seenIds.add(id);
            allAweme.push(item);
          }
        }
        console.log(
          `[profile] intercepted: +${list.length} items, unique total=${allAweme.length}, ` +
          `has_more=${json.has_more}, max_cursor=${json.max_cursor}`,
        );
      } catch {
        // ignore non-JSON or parse errors
      }
    });

    console.log(`[profile] navigating to profile: ${secUserId}`);
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    await page.waitForTimeout(3_000);
    console.log(`[profile] initial load done, collected=${allAweme.length}`);

    let staleCount = 0;
    let prevCount = allAweme.length;

    for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
      await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 3);
      });

      await page.waitForTimeout(SCROLL_PAUSE);

      const currentCount = allAweme.length;
      if (currentCount === prevCount) {
        staleCount++;
        console.log(
          `[profile] scroll ${round + 1}: no new videos (stale=${staleCount}/${STALE_LIMIT}), total=${currentCount}`,
        );
        if (staleCount >= STALE_LIMIT) {
          console.log(`[profile] no more videos after ${STALE_LIMIT} stale scrolls, stopping`);
          break;
        }
      } else {
        staleCount = 0;
        console.log(
          `[profile] scroll ${round + 1}: +${currentCount - prevCount} new, total=${currentCount}`,
        );
        prevCount = currentCount;
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
