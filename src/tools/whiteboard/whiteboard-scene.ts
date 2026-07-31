export const WHITEBOARD_OBJECT_TYPES = [
  "text",
  "image",
  "icon",
  "arrow",
  "shape",
  "other",
] as const;

export type WhiteboardObjectType = (typeof WHITEBOARD_OBJECT_TYPES)[number];

export const WHITEBOARD_HAND_STYLES = [
  "zigzag",
  "left_right",
  "right_left",
  "top_bottom",
  "svg_stroke_fill",
] as const;

export const WHITEBOARD_EFFECT_STYLES = [
  "zoom_in",
  "fade_in",
  "slide_up",
  "pop",
] as const;

export const WHITEBOARD_REVEAL_STYLES = [
  ...WHITEBOARD_HAND_STYLES,
  ...WHITEBOARD_EFFECT_STYLES,
] as const;

export type WhiteboardHandStyle = (typeof WHITEBOARD_HAND_STYLES)[number];
export type WhiteboardEffectStyle = (typeof WHITEBOARD_EFFECT_STYLES)[number];
export type WhiteboardRevealStyle = (typeof WHITEBOARD_REVEAL_STYLES)[number];
export type WhiteboardStrokePoint = [number, number];
export type WhiteboardStrokePath = WhiteboardStrokePoint[];

export interface WhiteboardObject {
  id: string;
  type: WhiteboardObjectType;
  /** [x1, y1, x2, y2] in source-image pixels, top-left to bottom-right. */
  bbox: [number, number, number, number];
  order: number;
  /** Optional reveal style; falls back to heuristic hand path when omitted. */
  revealStyle?: WhiteboardRevealStyle;
  /** Optional per-object drawing duration in seconds. */
  durationSec?: number;
  /** Sampled SVG geometry in source-canvas pixels. */
  strokePaths?: WhiteboardStrokePath[];
  /** Optional storyboard binding from idea generation. */
  storyboard?: WhiteboardObjectStoryboard;
}

export interface WhiteboardObjectStoryboard {
  /** 0-based index within the scene. */
  index: number;
  voice: string;
}

export interface WhiteboardSceneJson {
  imageWidth: number;
  imageHeight: number;
  objects: WhiteboardObject[];
}

const ALLOWED_TYPES = new Set<string>(WHITEBOARD_OBJECT_TYPES);
const ALLOWED_REVEAL_STYLES = new Set<string>(WHITEBOARD_REVEAL_STYLES);
const ALLOWED_HAND_STYLES = new Set<string>(WHITEBOARD_HAND_STYLES);

/** Boxes thinner than this in either axis carry no drawable area. */
const MIN_BOX_SIDE_PX = 4;

const MAX_ID_LENGTH = 64;
const MAX_STROKE_PATHS = 256;
const MAX_STROKE_POINTS = 4_000;

/**
 * Turn untrusted object candidates into a deterministic scene object list.
 *
 * Applied to both raw Gemini output and reviewer-edited payloads so the render
 * pipeline only ever sees clamped, uniquely-identified, contiguously-ordered
 * boxes. Order values are resequenced to 1..N after sorting, which keeps the
 * review badges and the hand path in agreement.
 */
export function normalizeSceneObjects(
  rawObjects: unknown,
  imageWidth: number,
  imageHeight: number,
): WhiteboardObject[] {
  if (!Array.isArray(rawObjects)) return [];

  const seenIds = new Set<string>();
  const objects: WhiteboardObject[] = [];

  rawObjects.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const obj = entry as Record<string, unknown>;

    const slug = String(obj.id ?? "")
      .trim()
      .replace(/\W+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, MAX_ID_LENGTH);
    const baseId = slug || `object_${index + 1}`;

    let uniqueId = baseId;
    let suffix = 2;
    while (seenIds.has(uniqueId)) uniqueId = `${baseId}_${suffix++}`;
    seenIds.add(uniqueId);

    const rawType = String(obj.type ?? "other")
      .trim()
      .toLowerCase();
    const type = (ALLOWED_TYPES.has(rawType) ? rawType : "other") as WhiteboardObjectType;

    const bbox = normalizeBbox(obj.bbox, imageWidth, imageHeight);
    if (!bbox) return;

    const rawOrder = Number(obj.order);
    const order = Number.isFinite(rawOrder) ? Math.max(1, Math.round(rawOrder)) : index + 1;

    const rawRevealStyle = String(obj.revealStyle ?? obj.handStyle ?? "")
      .trim()
      .toLowerCase();
    let revealStyle = ALLOWED_REVEAL_STYLES.has(rawRevealStyle)
      ? (rawRevealStyle as WhiteboardRevealStyle)
      : undefined;
    const strokePaths = normalizeStrokePaths(obj.strokePaths, bbox, imageWidth, imageHeight);
    if (revealStyle === "svg_stroke_fill" && strokePaths.length === 0) {
      revealStyle = "zigzag";
    }
    const rawDurationSec = Number(obj.durationSec);
    const durationSec =
      Number.isFinite(rawDurationSec) && rawDurationSec > 0
        ? Math.min(60, Math.max(0.1, rawDurationSec))
        : undefined;
    const storyboard = normalizeStoryboard(obj.storyboard);

    objects.push({
      id: uniqueId,
      type,
      bbox,
      order,
      ...(revealStyle ? { revealStyle } : {}),
      ...(durationSec ? { durationSec } : {}),
      ...(strokePaths.length ? { strokePaths } : {}),
      ...(storyboard ? { storyboard } : {}),
    });
  });

  objects.sort((a, b) => a.order - b.order || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  return objects.map((obj, index) => ({ ...obj, order: index + 1 }));
}

function normalizeStoryboard(raw: unknown): WhiteboardObjectStoryboard | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const row = raw as Record<string, unknown>;
  const voice = String(row.voice ?? "").trim();
  if (!voice) return undefined;
  const indexRaw = Number(row.index);
  const index = Number.isFinite(indexRaw) ? Math.max(0, Math.round(indexRaw)) : 0;
  return { index, voice };
}

function normalizeStrokePaths(
  raw: unknown,
  bbox: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
): WhiteboardStrokePath[] {
  if (!Array.isArray(raw)) return [];

  const paths: WhiteboardStrokePath[] = [];
  let totalPoints = 0;
  const [x1, y1, x2, y2] = bbox;

  for (const rawPath of raw.slice(0, MAX_STROKE_PATHS)) {
    if (!Array.isArray(rawPath) || totalPoints >= MAX_STROKE_POINTS) continue;
    const path: WhiteboardStrokePath = [];
    for (const rawPoint of rawPath) {
      if (totalPoints + path.length >= MAX_STROKE_POINTS) break;
      if (!Array.isArray(rawPoint) || rawPoint.length < 2) continue;
      const x = Number(rawPoint[0]);
      const y = Number(rawPoint[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      path.push([
        Math.round(Math.max(x1, Math.min(x2, Math.max(0, Math.min(imageWidth, x)))) * 10) / 10,
        Math.round(Math.max(y1, Math.min(y2, Math.max(0, Math.min(imageHeight, y)))) * 10) / 10,
      ]);
    }
    if (path.length >= 2) {
      paths.push(path);
      totalPoints += path.length;
    }
  }

  return paths;
}

export function isHandRevealStyle(style: WhiteboardRevealStyle | undefined): boolean {
  return Boolean(style && ALLOWED_HAND_STYLES.has(style));
}

export function isEffectRevealStyle(style: WhiteboardRevealStyle | undefined): boolean {
  return Boolean(style && (WHITEBOARD_EFFECT_STYLES as readonly string[]).includes(style));
}

/** Clamp to canvas, fix inverted corners, and reject boxes with no drawable area. */
function normalizeBbox(
  raw: unknown,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;

  const coords = raw.slice(0, 4).map((value) => Math.round(Number(value)));
  if (coords.some((value) => !Number.isFinite(value))) return null;

  const [rx1, ry1, rx2, ry2] = coords;
  const x1 = Math.max(0, Math.min(rx1, rx2));
  const y1 = Math.max(0, Math.min(ry1, ry2));
  const x2 = Math.min(imageWidth, Math.max(rx1, rx2));
  const y2 = Math.min(imageHeight, Math.max(ry1, ry2));

  if (x2 - x1 < MIN_BOX_SIDE_PX || y2 - y1 < MIN_BOX_SIDE_PX) return null;
  return [x1, y1, x2, y2];
}

/** Read `objects` out of a persisted sceneJson blob, if it holds a reviewed scene. */
export function readSceneObjects(
  sceneJson: Record<string, unknown> | null | undefined,
): unknown[] | null {
  const objects = sceneJson?.objects;
  return Array.isArray(objects) && objects.length > 0 ? objects : null;
}
