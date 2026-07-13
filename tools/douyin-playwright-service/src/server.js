const express = require("express");
const { extractProfile } = require("./extract-profile");
const { extractVideo } = require("./extract-video");
const { closeBrowser } = require("./shared");

const app = express();
const PORT = Number(process.env.PORT || 8000);

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
    const message = error instanceof Error ? error.message : "Extract video failed";
    const status = /invalid|could not|required|resolve/i.test(message) ? 400 : 500;
    console.error("[extract]", message);
    return res.status(status).json({ detail: message });
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
    const message = error instanceof Error ? error.message : "Extract profile failed";
    const status = /invalid|could not|required|no videos/i.test(message) ? 400 : 500;
    console.error("[extract-profile]", message);
    return res.status(status).json({ detail: message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`douyin-playwright-service listening on :${PORT}`);
});

async function shutdown() {
  console.log("Shutting down...");
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
