import { closeSync, existsSync, openSync, readSync, statSync } from "fs";
import { basename, extname, join } from "path";

import { resolveTranslateWorkRoot } from "../../common/desktop/data-path";

/** Last `Step N` marker in the tail of that video's pipeline.log. */
export function readPipelineStepFromVideoPath(videoPath: string | null | undefined): number | null {
  const raw = String(videoPath ?? "").trim();
  if (!raw) return null;
  const workName = basename(raw, extname(raw));
  if (!workName) return null;
  const logPath = join(resolveTranslateWorkRoot(), workName, "logs", "pipeline.log");
  if (!existsSync(logPath)) return null;

  const size = statSync(logPath).size;
  if (size <= 0) return null;
  const length = Math.min(size, 64_000);
  const buffer = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buffer, 0, length, size - length);
  } finally {
    closeSync(fd);
  }

  const stepRe = /\bStep\s*(\d+)/gi;
  let last: number | null = null;
  for (const match of buffer.toString("utf8").matchAll(stepRe)) {
    const step = Number(match[1]);
    if (Number.isFinite(step)) last = step;
  }
  return last;
}
