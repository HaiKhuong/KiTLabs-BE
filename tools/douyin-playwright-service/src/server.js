const express = require("express");
const { extractProfile } = require("./extract-profile");
const { extractVideo } = require("./extract-video");
const { closeBrowser } = require("./shared");

const app = express();
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST?.trim() || "0.0.0.0";

function errorPayload(error, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  const timeout = /timeout|timed out/i.test(message);
  const cookie = /cookie|empty body|no video data/i.test(message);
  const invalid = /invalid|must be|required|resolve aweme_id/i.test(message);

  return {
    status: invalid ? 400 : timeout ? 504 : 502,
    body: {
      message,
      code: invalid
        ? "DOUYIN_INVALID_URL"
        : timeout
          ? "DOUYIN_TIMEOUT"
          : cookie
            ? "DOUYIN_COOKIE_OR_ACCESS"
            : "DOUYIN_UPSTREAM_ERROR",
      retryable: !invalid,
    },
  };
}

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", provider: "playwright" });
});

app.post("/extract", async (req, res) => {
  const { url, cookie_content: cookieContent } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ detail: "url is required" });
  }

  try {
    const result = await extractVideo({
      url,
      cookieContent: cookieContent || null,
    });
    return res.json(result);
  } catch (error) {
    const failure = errorPayload(error, "Extract video failed");
    console.error("[extract]", failure.body.code, failure.body.message);
    return res.status(failure.status).json(failure.body);
  }
});

app.post("/extract-profile", async (req, res) => {
  const {
    url,
    cookie_content: cookieContent,
    max_videos: maxVideos,
    cursor,
  } = req.body || {};

  if (!url || typeof url !== "string") {
    return res.status(400).json({ detail: "url is required" });
  }

  const limit = Number(maxVideos) > 0 ? Math.min(Number(maxVideos), 50) : 20;
  const startCursor = Number(cursor) >= 0 ? Number(cursor) : 0;

  try {
    const result = await extractProfile({
      url,
      cookieContent: cookieContent || null,
      maxVideos: limit,
      cursor: startCursor,
    });
    return res.json(result);
  } catch (error) {
    const failure = errorPayload(error, "Extract profile failed");
    console.error("[extract-profile]", failure.body.code, failure.body.message);
    return res.status(failure.status).json(failure.body);
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log(`douyin-playwright-service listening on ${HOST}:${PORT}`);
});

async function shutdown() {
  console.log("Shutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
