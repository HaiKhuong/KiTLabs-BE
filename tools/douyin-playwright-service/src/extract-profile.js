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
  const MAX_SCROLL = 100;
  const STALE_LIMIT = 8;

  // Large viewport so Douyin loads more content
  const { context, page } = await createDouyinPage(cookieContent, {
    viewport: { width: 1920, height: 4000 },
  });

  try {
    const allAweme = [];
    const seenIds = new Set();

    function addItem(item) {
      const id = item.aweme_id || item.awemeId;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        allAweme.push(item);
        return true;
      }
      return false;
    }

    // Intercept ALL API responses for post listing
    page.on("response", async (response) => {
      const url = response.url();
      if (!url.includes("/aweme/") || !url.includes("/post")) return;
      try {
        const json = await response.json();
        const list = json?.aweme_list;
        if (!Array.isArray(list) || list.length === 0) return;
        let added = 0;
        for (const item of list) {
          if (addItem(item)) added++;
        }
        console.log(
          `[profile] API intercepted: +${added} new, total=${allAweme.length}, ` +
          `has_more=${json.has_more}, cursor=${json.max_cursor}`,
        );
      } catch { /* ignore */ }
    });

    console.log(`[profile] navigating to profile (viewport 1920x4000)`);
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "networkidle",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    console.log(`[profile] after networkidle: ${allAweme.length} videos from API intercept`);

    // Also try manual fetch for first page as fallback
    if (allAweme.length === 0) {
      console.log(`[profile] trying manual fetch fallback...`);
      const manualResult = await page.evaluate(
        async ({ userId }) => {
          const apiUrl =
            `https://www.douyin.com/aweme/v1/web/aweme/post/` +
            `?device_platform=webapp&aid=6383&channel=channel_pc_web` +
            `&sec_user_id=${encodeURIComponent(userId)}` +
            `&max_cursor=0`;

          const response = await fetch(apiUrl, {
            headers: {
              accept: "application/json, text/plain, */*",
              "accept-language": "vi",
            },
            credentials: "include",
            method: "GET",
            mode: "cors",
          });

          if (!response.ok) return [];
          const data = await response.json();
          return data?.aweme_list || [];
        },
        { userId: secUserId },
      );

      for (const item of manualResult) {
        addItem(item);
      }
      console.log(`[profile] manual fetch: +${manualResult.length}, total=${allAweme.length}`);
    }

    // Scroll to load more
    let staleCount = 0;
    let prevCount = allAweme.length;

    for (let round = 0; round < MAX_SCROLL; round++) {
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
      });
      await page.waitForTimeout(2000);

      const currentCount = allAweme.length;
      if (currentCount > prevCount) {
        console.log(
          `[profile] scroll ${round + 1}: +${currentCount - prevCount}, total=${currentCount}`,
        );
        staleCount = 0;
        prevCount = currentCount;
      } else {
        staleCount++;
        if (staleCount >= STALE_LIMIT) {
          console.log(`[profile] ${STALE_LIMIT} stale scrolls, stopping. total=${currentCount}`);
          break;
        }
      }
    }

    if (!allAweme.length) {
      const title = await page.title();
      const bodyLen = await page.evaluate(() => document.body.innerHTML.length);
      console.log(`[profile] page title="${title}", body=${bodyLen} chars`);
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
