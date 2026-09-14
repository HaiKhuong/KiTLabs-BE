import { existsSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import type { NarratoStepId } from "./narrato-steps.constants";

function removePath(target: string): void {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
}

export function truncateNarratoPipelineLog(workDir: string, marker: string): void {
  const logPath = join(workDir, "logs", "pipeline.log");
  try {
    writeFileSync(logPath, `${marker}\n`, "utf-8");
  } catch {
    /* log dir may not exist yet */
  }
}

export function cleanupNarratoStepArtifacts(step: NarratoStepId, workDir: string): void {
  switch (step) {
    case "ingest":
      removePath(join(workDir, "transcript.json"));
      removePath(join(workDir, "transcript.srt"));
      break;
    case "plot":
      removePath(join(workDir, "plot.md"));
      break;
    case "copy":
      removePath(join(workDir, "narration_copy.txt"));
      break;
    case "match":
      removePath(join(workDir, "script.json"));
      break;
    case "mix":
      // mix rewrites script.json from match — keep match output
      break;
    case "render":
      removePath(join(workDir, "output"));
      removePath(join(workDir, "clips"));
      break;
    default:
      break;
  }
}
