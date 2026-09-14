import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import type { RecapStepId } from "./recap-steps.constants";

function removePath(target: string): void {
  if (!existsSync(target)) return;
  rmSync(target, { recursive: true, force: true });
}

function stripCandidateShots(workDir: string): void {
  const filePath = join(workDir, "story_knowledge.json");
  if (!existsSync(filePath)) return;
  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    const events = Array.isArray(raw.events) ? raw.events : [];
    for (const event of events) {
      if (!event || typeof event !== "object" || Array.isArray(event)) continue;
      const row = event as Record<string, unknown>;
      delete row.candidate_shots;
      delete row.candidateShots;
    }
    writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf-8");
  } catch {
    /* leave file if parse fails */
  }
}

export function truncatePipelineLog(workDir: string, marker: string): void {
  const logPath = join(workDir, "logs", "pipeline.log");
  try {
    writeFileSync(logPath, `${marker}\n`, "utf-8");
  } catch {
    /* log dir may not exist yet */
  }
}

export function cleanupRecapStepArtifacts(step: RecapStepId, workDir: string): void {
  switch (step) {
    case "asr":
      removePath(join(workDir, "transcript.srt"));
      removePath(join(workDir, "transcript.json"));
      break;
    case "scenes":
      removePath(join(workDir, "shots.json"));
      break;
    case "cluster":
      removePath(join(workDir, "semantic_scenes.json"));
      removePath(join(workDir, "shot_embeddings.json"));
      removePath(join(workDir, "keyframes"));
      break;
    case "call_a1":
      removePath(join(workDir, "story_knowledge.json"));
      removePath(join(workDir, "story_analysis.md"));
      break;
    case "candidates":
      stripCandidateShots(workDir);
      break;
    case "vlm":
      removePath(join(workDir, "vlm_evidence.json"));
      break;
    case "call_a2":
      removePath(join(workDir, "script.json"));
      removePath(join(workDir, "segments.json"));
      break;
    case "tts":
      removePath(join(workDir, "tts.json"));
      removePath(join(workDir, "audio"));
      break;
    case "call_b":
      removePath(join(workDir, "picks.json"));
      removePath(join(workDir, "timeline.json"));
      break;
    case "render":
      removePath(join(workDir, "output"));
      removePath(join(workDir, "clips"));
      removePath(join(workDir, "concat_video.txt"));
      removePath(join(workDir, "concat_voice.txt"));
      removePath(join(workDir, "video_only.mp4"));
      removePath(join(workDir, "voice_mix.wav"));
      break;
    default:
      break;
  }
}
