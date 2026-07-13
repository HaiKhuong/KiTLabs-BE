const fs = require("fs");
const path = require("path");

const url = process.argv[2] || "https://v.douyin.com/fPIVGeckUOg/";
const cookieFile =
  process.argv[3] || path.join(__dirname, "..", "..", "secrets", "douyin-cookies.txt");
const output = process.argv[4] || "video.json";

const cookiePath = path.isAbsolute(cookieFile)
  ? cookieFile
  : path.join(__dirname, cookieFile);

const body = { url };

if (fs.existsSync(cookiePath)) {
  body.cookie_content = fs.readFileSync(cookiePath, "utf8");
}

const outPath = path.join(__dirname, output);
fs.writeFileSync(outPath, JSON.stringify(body), "utf8");
console.log(`Wrote ${outPath}`);
