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

type RecapFileExtras = {
  resultPath?: string | null;
  readText?: (path: string) => string | null;
};

const SRT_RANGE_RE =
  /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function padMs(raw: string): number {
  const digits = raw.replace(/\D/g, "") || "0";
  return Number((digits + "000").slice(0, 3));
}

function srtPartsToSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + padMs(ms) / 1000;
}

export type RecapSrtCue = {
  index: number;
  startSec: number;
  endSec: number;
  start: string;
  end: string;
  text: string;
};

export function parseSrtCues(srt: string): RecapSrtCue[] {
  const raw = (srt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!raw) return [];
  const chunks = raw.split(/\n\s*\n/);
  const cues: RecapSrtCue[] = [];
  for (const chunk of chunks) {
    const lines = chunk
      .split("\n")
      .map((ln) => ln.trim())
      .filter(Boolean);
    if (!lines.length) continue;
    const tsIdx = /^\d+$/.test(lines[0]) && lines.length > 1 ? 1 : 0;
    const tsLine = lines[tsIdx];
    if (!tsLine) continue;
    const match = tsLine.match(SRT_RANGE_RE);
    if (!match) continue;
    const startSec = srtPartsToSec(match[1], match[2], match[3], match[4]);
    const endSec = srtPartsToSec(match[5], match[6], match[7], match[8]);
    const text = lines.slice(tsIdx + 1).join("\n").trim();
    if (!text) continue;
    const start = `${match[1].padStart(2, "0")}:${match[2]}:${match[3]},${String(padMs(match[4])).padStart(3, "0")}`;
    const end = `${match[5].padStart(2, "0")}:${match[6]}:${match[7]},${String(padMs(match[8])).padStart(3, "0")}`;
    cues.push({
      index: cues.length + 1,
      startSec,
      endSec: Math.max(endSec, startSec + 0.001),
      start,
      end,
      text,
    });
  }
  return cues;
}

function loadAsrCues(
  workDir: string,
  readJson: (path: string) => unknown | null,
  readText?: (path: string) => string | null,
): RecapSrtCue[] {
  const srt = readText?.(join(workDir, "transcript.srt"));
  if (srt) return parseSrtCues(srt);
  const transcript = readJsonRecord(readJson, join(workDir, "transcript.json"));
  const segments = asArray(transcript?.segments);
  return segments.map((seg, idx) => {
    const row = asRecord(seg);
    const startSec = Number(row.startSec ?? row.start ?? 0);
    const endSec = Number(row.endSec ?? row.end ?? startSec);
    return {
      index: idx + 1,
      startSec,
      endSec,
      start: String(row.start ?? startSec),
      end: String(row.end ?? endSec),
      text: String(row.text ?? row.content ?? ""),
    };
  });
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
  extras?: RecapFileExtras,
): RecapStepSummary | null {
  const readText = extras?.readText;
  switch (step) {
    case "asr": {
      const cues = loadAsrCues(workDir, readJson, readText);
      if (!cues.length) return null;
      const preview = cues
        .slice(0, 3)
        .map((cue) => `[${cue.start}] ${cue.text}`)
        .join(" · ");
      return {
        label: `${cues.length} cues`,
        detail: truncateText(preview),
        metrics: { cueCount: cues.length },
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
      const analysis = readText?.(join(workDir, "story_analysis.md"))?.trim() ?? "";
      if (!events.length && !characters.length && !analysis) return null;
      return {
        label: `${events.length} events · ${characters.length} chars`,
        detail: analysis ? truncateText(analysis.replace(/\s+/g, " "), 160) : undefined,
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
    case "vlm": {
      const vlm = readJsonRecord(readJson, join(workDir, "vlm_evidence.json"));
      if (!vlm) return null;
      if (vlm.skipped) {
        return {
          label: "Skipped",
          detail: String(vlm.reason ?? ""),
          metrics: { skipped: true },
        };
      }
      const eventCount = Number(vlm.eventCount ?? asArray(vlm.events).length);
      const imageCount = Number(vlm.imageCount ?? 0);
      return {
        label: `${eventCount} events · ${imageCount} frames`,
        metrics: { eventCount, imageCount },
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
  extras?: RecapFileExtras,
): Record<string, unknown> {
  const readText = extras?.readText;
  switch (step) {
    case "asr": {
      const cues = loadAsrCues(workDir, readJson, readText);
      return {
        format: "srt",
        segments: cues.slice(0, 200),
        totalSegments: cues.length,
        truncated: cues.length > 200,
        srtPreview: (readText?.(join(workDir, "transcript.srt")) ?? "").slice(0, 4000),
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
      const analysisMarkdown =
        step === "call_a1" ? readText?.(join(workDir, "story_analysis.md")) ?? "" : "";
      return {
        view: step,
        events,
        characters,
        totalEvents: asArray(knowledge?.events).length,
        totalCharacters: asArray(knowledge?.characters).length,
        movieSummary: knowledge?.movieSummary ?? "",
        analysisMarkdown,
      };
    }
    case "vlm": {
      const vlm = readJsonRecord(readJson, join(workDir, "vlm_evidence.json")) ?? {};
      const knowledge = readJsonRecord(readJson, join(workDir, "story_knowledge.json"));
      const events = asArray(knowledge?.events)
        .slice(0, 40)
        .map((event) => {
          const row = asRecord(event);
          return {
            eventId: row.eventId,
            title: row.title,
            visualEvidence: row.visualEvidence ?? "",
            vlmShotIds: row.vlmShotIds ?? [],
          };
        });
      return { ...vlm, events };
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
