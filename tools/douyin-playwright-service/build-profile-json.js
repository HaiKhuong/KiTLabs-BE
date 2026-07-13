const fs = require("fs");
const path = require("path");

const url =
  process.argv[2] ||
  "https://www.douyin.com/user/MS4wLjABAAAAD4jrXw9aKEvvJMz8xrxm5XBUUxVWTKtZDcHuPbSdVqw";
const cookieFile = process.argv[3] || path.join(__dirname, "..", "..", "secrets", "douyin-cookies.txt");
const output = process.argv[4] || "profile.json";
const maxVideos = Number(process.argv[5]) > 0 ? Number(process.argv[5]) : 20;
const cursor = Number(process.argv[6]) >= 0 ? Number(process.argv[6]) : 0;

const cookiePath = path.isAbsolute(cookieFile)
  ? cookieFile
  : path.join(__dirname, cookieFile);

const body = {
  url,
  max_videos: maxVideos,
  cursor,
};

if (fs.existsSync(cookiePath)) {
  body.cookie_content = fs.readFileSync(cookiePath, "utf8");
}

const outPath = path.join(__dirname, output);
fs.writeFileSync(outPath, JSON.stringify(body), "utf8");
console.log(`Wrote ${outPath}`);
