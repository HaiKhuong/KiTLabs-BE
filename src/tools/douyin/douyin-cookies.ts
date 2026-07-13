import * as fs from "fs";
import * as path from "path";

import { DOUYIN_COOKIE_FILE } from "./douyin.constants";

export function getDouyinCookieContent(): string | null {
  const inline = process.env.DOUYIN_COOKIE_CONTENT?.trim();
  if (inline) {
    return inline;
  }

  const filePath = path.isAbsolute(DOUYIN_COOKIE_FILE)
    ? DOUYIN_COOKIE_FILE
    : path.join(process.cwd(), DOUYIN_COOKIE_FILE);

  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const content = fs.readFileSync(filePath, "utf8").trim();
    return content || null;
  } catch {
    return null;
  }
}
