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
 * Parse embedded SSR data from the profile page HTML.
 * Douyin embeds video data in RENDER_DATA or hydration globals.
 */
async function parseSSRVideos(page) {
  return page.evaluate(() => {
    function findAwemeList(obj, depth = 0) {
      if (!obj || typeof obj !== "object" || depth > 12) return [];
      if (Array.isArray(obj.aweme_list) && obj.aweme_list.length > 0) {
        return obj.aweme_list;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = findAwemeList(item, depth + 1);
          if (found.length > 0) return found;
        }
        return [];
      }
      for (const value of Object.values(obj)) {
        if (value && typeof value === "object") {
          const found = findAwemeList(value, depth + 1);
          if (found.length > 0) return found;
        }
      }
      return [];
    }

    const sources = [];

    // RENDER_DATA script tag
    const renderScript = document.querySelector("script#RENDER_DATA");
    if (renderScript?.textContent) {
      try {
        sources.push(JSON.parse(decodeURIComponent(renderScript.textContent)));
      } catch { /* ignore */ }
    }

    // Global hydration data
    if (window.__UNIVERSAL_DATA_FOR_REHYDRATION__) {
      sources.push(window.__UNIVERSAL_DATA_FOR_REHYDRATION__);
    }
    if (window._SSR_HYDRATED_DATA) {
      sources.push(window._SSR_HYDRATED_DATA);
    }

    for (const source of sources) {
      const list = findAwemeList(source);
      if (list.length > 0) return list;
    }

    return [];
  });
}

async function extractProfile({ url, cookieContent }) {
  const secUserId = extractSecUserId(url);
  const MAX_SCROLL_ROUNDS = 80;
  const SCROLL_PAUSE = 2000;
  const STALE_LIMIT = 6;

  const { context, page } = await createDouyinPage(cookieContent);

  try {
    const allAweme = [];
    const seenIds = new Set();

    function addAweme(item) {
      const id = item.aweme_id || item.awemeId;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        allAweme.push(item);
        return true;
      }
      return false;
    }

    // Intercept API responses during page load AND scroll
    page.on("response", async (response) => {
      if (!response.url().includes("/aweme/v1/web/aweme/post")) return;
      try {
        const json = await response.json();
        const list = json?.aweme_list;
        if (!Array.isArray(list)) return;
        let added = 0;
        for (const item of list) {
          if (addAweme(item)) added++;
        }
        console.log(
          `[profile] intercepted API: +${added} new (${list.length} total in response), ` +
          `unique=${allAweme.length}, has_more=${json.has_more}`,
        );
      } catch { /* ignore */ }
    });

    console.log(`[profile] navigating to profile: ${secUserId}`);
    await page.goto(`${DOUYIN_ORIGIN}/user/${secUserId}`, {
      waitUntil: "load",
      timeout: 60_000,
    });
    await page.waitForTimeout(3_000);

    // Parse SSR embedded data
    const ssrList = await parseSSRVideos(page);
    if (ssrList.length > 0) {
      let added = 0;
      for (const item of ssrList) {
        if (addAweme(item)) added++;
      }
      console.log(`[profile] SSR data: +${added} videos (${ssrList.length} in SSR)`);
    }

    console.log(`[profile] after initial load: ${allAweme.length} videos`);

    // Scroll to load more
    let staleCount = 0;
    let prevCount = allAweme.length;

    for (let round = 0; round < MAX_SCROLL_ROUNDS; round++) {
      // Scroll using mouse wheel (more realistic than scrollBy)
      await page.mouse.wheel(0, 3000);
      await page.waitForTimeout(SCROLL_PAUSE);

      const currentCount = allAweme.length;
      if (currentCount === prevCount) {
        staleCount++;
        if (staleCount % 2 === 0) {
          console.log(
            `[profile] scroll ${round + 1}: stale=${staleCount}/${STALE_LIMIT}, total=${currentCount}`,
          );
        }
        if (staleCount >= STALE_LIMIT) {
          console.log(`[profile] stopping after ${STALE_LIMIT} stale scrolls`);
          break;
        }
      } else {
        console.log(
          `[profile] scroll ${round + 1}: +${currentCount - prevCount} new, total=${currentCount}`,
        );
        staleCount = 0;
        prevCount = currentCount;
      }
    }

    if (!allAweme.length) {
      // Last resort: check page title/content for debugging
      const title = await page.title();
      console.log(`[profile] page title: ${title}`);
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
