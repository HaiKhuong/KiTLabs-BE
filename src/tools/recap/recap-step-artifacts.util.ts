import { existsSync } from "fs";
import { join } from "path";

import type { RecapStepId } from "./recap-steps.constants";

export type RecapStepSummary = {
  label: string;
  detail?: string;
  metrics?: Record<string, number | string | boolean>;
};

export type RecapStepSummaries = Partial<Record<RecapStepId, RecapStepSummary>>;

type JsonValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readJsonFile(readJson: (path: string) => unknown | null, fileName: string): JsonValue | null {
  const data = readJson(fileName);
  if (data == null) return null;
  if (typeof data === "object") return data as JsonValue;
  return null;
}

function readJsonRecord(readJson: (path: string) => unknown | null, fileName: string): Record<string, unknown> | null {
  const data = readJson(fileName);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return null;
}

function truncateText(text: string, max = 120): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

function transcriptPreview(segments: unknown[], limit = 3): string {
  const lines = segments
    .slice(0, limit)
    .map((seg) => {
      const row = asRecord(seg);
      const text = String(row.text ?? row.content ?? "").trim();
      const start = row.start ?? row.t0;
      return start != null ? `[${start}] ${text}` : text;
    })
    .filter(Boolean);
  return lines.join(" · ");
}

export function readRecapStepSummaries(
  engineConfig: Record<string, unknown> | null | undefined,
): RecapStepSummaries {
  const raw = engineConfig?.recapStepSummaries;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return raw as RecapStepSummaries;
}

export function buildRecapStepSummary(
  step: RecapStepId,
  workDir: string,
  readJson: (path: string) => unknown | null,
  extras?: { resultPath?: string | null },
): RecapStepSummary | null {
  switch (step) {
    case "asr": {
      const transcript = readJsonFile(readJson, join(workDir, "transcript.json"));
      const segments = asArray(asRecord(transcript).segments);
      if (!segments.length) return null;
      return {
        label: `${segments.length} segments`,
        detail: truncateText(transcriptPreview(segments)),
        metrics: { segmentCount: segments.length },
      };
    }
    case "scenes": {
      const shotsRaw = readJson(join(workDir, "shots.json"));
      const shots = Array.isArray(shotsRaw) ? shotsRaw : asArray(asRecord(shotsRaw).shots);
      if (!shots.length) return null;
      return {
        label: `${shots.length} shots`,
        metrics: { shotCount: shots.length },
      };
    }
    case "cluster": {
      const semantic = readJsonFile(readJson, join(workDir, "semantic_scenes.json"));
      const scenes = asArray(asRecord(semantic).scenes);
      if (!scenes.length) return null;
      return {
        label: `${scenes.length} scenes`,
        metrics: { sceneCount: scenes.length },
      };
    }
    case "call_a1": {
      const knowledge = readJsonRecord(readJson, join(workDir, "story_knowledge.json"));
      const events = asArray(knowledge?.events);
      const characters = asArray(knowledge?.characters);
      if (!events.length && !characters.length) return null;
      return {
        label: `${events.length} events · ${characters.length} chars`,
        metrics: { eventCount: events.length, characterCount: characters.length },
      };
    }
    case "candidates": {
      const knowledge = readJsonRecord(readJson, join(workDir, "story_knowledge.json"));
      const events = asArray(knowledge?.events);
      const candidateLinkCount = events.reduce<number>((sum, event) => {
        const row = asRecord(event);
        return sum + asArray(row.candidate_shots).length;
      }, 0);
      if (!candidateLinkCount) return null;
      return {
        label: `${candidateLinkCount} candidate links`,
        metrics: { candidateLinkCount },
      };
    }
    case "call_a2": {
      const script = readJsonRecord(readJson, join(workDir, "script.json"));
      const segmentsRaw = readJson(join(workDir, "segments.json"));
      const segments = asArray(asRecord(segmentsRaw).segments ?? segmentsRaw);
      const narrations = asArray(script?.narrations ?? script?.n);
      const count = segments.length || narrations.length;
      if (!count) return null;
      const durationSec = script?.durationSec ?? script?.d;
      const preview = narrations
        .slice(0, 2)
        .map((n) => truncateText(String(n), 60))
        .join(" · ");
      return {
        label: `${count} segments${durationSec != null ? ` · ${durationSec}s` : ""}`,
        detail: preview || undefined,
        metrics: {
          segmentCount: count,
          ...(durationSec != null ? { durationSec: Number(durationSec) } : {}),
        },
      };
    }
    case "tts": {
      const tts = readJsonRecord(readJson, join(workDir, "tts.json"));
      const files = asArray(tts?.files ?? tts);
      const audioFileCount = files.length || Object.keys(asRecord(tts)).length;
      if (!audioFileCount) return null;
      return {
        label: `${audioFileCount} audio files`,
        metrics: { audioFileCount },
      };
    }
    case "call_b": {
      const picks = readJsonRecord(readJson, join(workDir, "picks.json"));
      const selected = asArray(picks?.selected_shots ?? picks?.selectedShots);
      const pickedSegmentCount = selected.length;
      if (!pickedSegmentCount) return null;
      return {
        label: `${pickedSegmentCount} segments picked`,
        metrics: { pickedSegmentCount },
      };
    }
    case "render": {
      const timeline = readJsonRecord(readJson, join(workDir, "timeline.json"));
      const durationSec = timeline?.durationSec;
      const videoPath = extras?.resultPath ?? join(workDir, "output", "recap.mp4");
      const hasVideo = Boolean(videoPath && existsSync(videoPath));
      if (!hasVideo && durationSec == null) return null;
      return {
        label: hasVideo ? "Video sẵn sàng" : "Timeline built",
        detail: durationSec != null ? `${durationSec}s recap` : undefined,
        metrics: {
          ...(durationSec != null ? { durationSec: Number(durationSec) } : {}),
          hasVideo,
        },
      };
    }
    default:
      return null;
  }
}

export function buildRecapStepArtifactPayload(
  step: RecapStepId,
  workDir: string,
  readJson: (path: string) => unknown | null,
  history: { id: string; resultPath?: string | null; playUrl?: string | null },
): Record<string, unknown> {
  switch (step) {
    case "asr": {
      const transcript = readJsonRecord(readJson, join(workDir, "transcript.json"));
      const segments = asArray(transcript?.segments);
      return {
        segments: segments.slice(0, 200),
        totalSegments: segments.length,
        truncated: segments.length > 200,
      };
    }
    case "scenes": {
      const shotsRaw = readJson(join(workDir, "shots.json"));
      const shots = Array.isArray(shotsRaw) ? shotsRaw : asArray(asRecord(shotsRaw).shots);
      return { shots: shots.slice(0, 300), totalShots: shots.length, truncated: shots.length > 300 };
    }
    case "cluster": {
      const semantic = readJsonRecord(readJson, join(workDir, "semantic_scenes.json"));
      const scenes = asArray(semantic?.scenes);
      return { scenes: scenes.slice(0, 100), totalScenes: scenes.length, truncated: scenes.length > 100 };
    }
    case "call_a1":
    case "candidates": {
      const knowledge = readJsonRecord(readJson, join(workDir, "story_knowledge.json"));
      const events = asArray(knowledge?.events).slice(0, 50);
      const characters = asArray(knowledge?.characters).slice(0, 30);
      return {
        view: step,
        events,
        characters,
        totalEvents: asArray(knowledge?.events).length,
        totalCharacters: asArray(knowledge?.characters).length,
      };
    }
    case "call_a2": {
      const script = readJsonRecord(readJson, join(workDir, "script.json"));
      const segmentsRaw = readJson(join(workDir, "segments.json"));
      const segments = asArray(asRecord(segmentsRaw).segments ?? segmentsRaw);
      return { script, segments };
    }
    case "tts": {
      const tts = readJsonRecord(readJson, join(workDir, "tts.json")) ?? readJson(join(workDir, "tts.json"));
      return { tts };
    }
    case "call_b": {
      const picks = readJsonRecord(readJson, join(workDir, "picks.json"));
      const timeline = readJsonRecord(readJson, join(workDir, "timeline.json"));
      return { picks, timeline };
    }
    case "render": {
      return {
        playUrl: history.playUrl ?? `/api/tools/recap/artifact?recapHistoryId=${history.id}&type=video`,
        downloadUrl: history.playUrl ?? `/api/tools/recap/artifact?recapHistoryId=${history.id}&type=video`,
        hasVideo: Boolean(history.resultPath && existsSync(history.resultPath)),
      };
    }
    default:
      return {};
  }
}
