import type { WhiteboardObject, WhiteboardSceneJson } from "./whiteboard-scene";
import type { WhiteboardPathPlan } from "./whiteboard-path-planner";

export type WhiteboardCameraZoomGroupInput = {
  storyboardIndices: number[];
};

export type WhiteboardCameraKeyframe = {
  /** Absolute timeline second. */
  atSec: number;
  /** View rect in source-image pixels [x1, y1, x2, y2]. */
  bbox: [number, number, number, number];
};

export type WhiteboardCameraPlan = {
  keyframes: WhiteboardCameraKeyframe[];
};

const TRANSITION_SEC = 0.6;
/** Fixed camera zoom factor (2 = show half the canvas, 16:9). */
const ZOOM_FACTOR = 2;

type VoiceWindow = { index: number; startSec: number; durationSec: number };

/**
 * Build camera keyframes from zoom groups + voice/draw windows.
 * Full frame when not in a zoom shot; ease in before group start and out after group end.
 */
export function buildWhiteboardCameraPlan(opts: {
  scene: WhiteboardSceneJson;
  pathPlan: WhiteboardPathPlan;
  voiceSchedule?: VoiceWindow[];
  cameraZooms?: WhiteboardCameraZoomGroupInput[] | null;
  imageWidth: number;
  imageHeight: number;
}): WhiteboardCameraPlan | null {
  const groups = normalizeZoomGroups(opts.cameraZooms);
  if (groups.length === 0) return null;

  const W = Math.max(1, opts.imageWidth);
  const H = Math.max(1, opts.imageHeight);
  const full: [number, number, number, number] = [0, 0, W, H];

  const scheduleByIndex = new Map(
    (opts.voiceSchedule ?? []).map((entry) => [entry.index, entry]),
  );
  const objectsBySb = groupObjectsByStoryboard(opts.scene.objects);
  const pathsBySb = groupPathsByStoryboard(opts.pathPlan, opts.scene.objects);

  type Shot = {
    startSec: number;
    endSec: number;
    target: [number, number, number, number];
  };

  const shots: Shot[] = [];
  for (const indices of groups) {
    const window = resolveGroupWindow(indices, scheduleByIndex, pathsBySb);
    if (!window) continue;

    const union = unionBboxes(indices.flatMap((index) => objectsBySb.get(index) ?? []));
    if (!union) continue;

    const target = fixedZoomRect(union, W, H, ZOOM_FACTOR);
    shots.push({ startSec: window.startSec, endSec: window.endSec, target });
  }

  if (shots.length === 0) return null;
  shots.sort((a, b) => a.startSec - b.startSec);

  const keyframes: WhiteboardCameraKeyframe[] = [{ atSec: 0, bbox: full }];
  let prevHoldEnd = 0;

  for (const shot of shots) {
    const maxIn = Math.max(0, shot.startSec - prevHoldEnd);
    const transitionIn = Math.min(TRANSITION_SEC, maxIn);
    const zoomInStart = shot.startSec - transitionIn;

    if (zoomInStart > prevHoldEnd + 1e-4) {
      keyframes.push({ atSec: zoomInStart, bbox: [...full] as [number, number, number, number] });
    }
    keyframes.push({
      atSec: shot.startSec,
      bbox: [...shot.target] as [number, number, number, number],
    });
    keyframes.push({
      atSec: shot.endSec,
      bbox: [...shot.target] as [number, number, number, number],
    });

    const nextStart =
      shots.find((candidate) => candidate.startSec > shot.endSec + 1e-6)?.startSec ??
      Number.POSITIVE_INFINITY;
    const maxOut = Number.isFinite(nextStart)
      ? Math.max(0, nextStart - shot.endSec)
      : TRANSITION_SEC;
    const transitionOut = Math.min(TRANSITION_SEC, maxOut);
    const zoomOutEnd = shot.endSec + transitionOut;

    keyframes.push({
      atSec: zoomOutEnd,
      bbox: [...full] as [number, number, number, number],
    });
    prevHoldEnd = zoomOutEnd;
  }

  // Deduplicate identical consecutive times (keep last).
  const cleaned: WhiteboardCameraKeyframe[] = [];
  for (const kf of keyframes) {
    const last = cleaned[cleaned.length - 1];
    if (last && Math.abs(last.atSec - kf.atSec) < 1e-4) {
      cleaned[cleaned.length - 1] = kf;
    } else {
      cleaned.push(kf);
    }
  }

  return { keyframes: cleaned };
}

function normalizeZoomGroups(
  raw: WhiteboardCameraZoomGroupInput[] | null | undefined,
): number[][] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const used = new Set<number>();
  const groups: number[][] = [];
  for (const group of raw) {
    const indices = Array.isArray(group?.storyboardIndices)
      ? [
          ...new Set(
            group.storyboardIndices
              .map((value) => Math.trunc(Number(value)))
              .filter((value) => Number.isFinite(value) && value >= 0 && !used.has(value)),
          ),
        ].sort((a, b) => a - b)
      : [];
    if (indices.length === 0) continue;
    for (const index of indices) used.add(index);
    groups.push(indices);
  }
  return groups;
}

function groupObjectsByStoryboard(
  objects: WhiteboardObject[],
): Map<number, WhiteboardObject[]> {
  const map = new Map<number, WhiteboardObject[]>();
  for (const obj of objects) {
    const index = obj.storyboard?.index;
    if (typeof index !== "number" || !Number.isFinite(index)) continue;
    const list = map.get(index) ?? [];
    list.push(obj);
    map.set(index, list);
  }
  return map;
}

function groupPathsByStoryboard(
  pathPlan: WhiteboardPathPlan,
  objects: WhiteboardObject[],
): Map<number, WhiteboardPathPlan["objectPaths"]> {
  const objIndex = new Map(objects.map((obj) => [obj.id, obj.storyboard?.index]));
  const map = new Map<number, WhiteboardPathPlan["objectPaths"]>();
  for (const path of pathPlan.objectPaths) {
    const index = objIndex.get(path.objectId);
    if (typeof index !== "number") continue;
    const list = map.get(index) ?? [];
    list.push(path);
    map.set(index, list);
  }
  return map;
}

function resolveGroupWindow(
  indices: number[],
  scheduleByIndex: Map<number, VoiceWindow>,
  pathsBySb: Map<number, WhiteboardPathPlan["objectPaths"]>,
): { startSec: number; endSec: number } | null {
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const index of indices) {
    const voice = scheduleByIndex.get(index);
    if (voice) {
      found = true;
      startSec = Math.min(startSec, voice.startSec);
      endSec = Math.max(endSec, voice.startSec + voice.durationSec);
      continue;
    }
    const paths = pathsBySb.get(index) ?? [];
    for (const path of paths) {
      found = true;
      startSec = Math.min(startSec, path.drawStartSec);
      endSec = Math.max(endSec, path.drawStartSec + path.drawDurationSec);
    }
  }

  if (!found || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec) {
    return null;
  }
  return { startSec, endSec };
}

function unionBboxes(objects: WhiteboardObject[]): [number, number, number, number] | null {
  if (objects.length === 0) return null;
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const obj of objects) {
    const [bx1, by1, bx2, by2] = obj.bbox;
    x1 = Math.min(x1, bx1);
    y1 = Math.min(y1, by1);
    x2 = Math.max(x2, bx2);
    y2 = Math.max(y2, by2);
  }
  if (!(x2 > x1 && y2 > y1)) return null;
  return [x1, y1, x2, y2];
}

/**
 * Fixed zoom (default ×2): view is W/zoom × H/zoom, centered on the union
 * centroid and clamped to the canvas — top-left content → top-left shot, etc.
 */
export function fixedZoomRect(
  union: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
  zoomFactor: number,
): [number, number, number, number] {
  const zoom = Math.max(1, zoomFactor);
  const w = imageWidth / zoom;
  const h = imageHeight / zoom;
  const [ux1, uy1, ux2, uy2] = union;
  const cx = (ux1 + ux2) / 2;
  const cy = (uy1 + uy2) / 2;

  let x1 = cx - w / 2;
  let y1 = cy - h / 2;
  x1 = Math.max(0, Math.min(x1, imageWidth - w));
  y1 = Math.max(0, Math.min(y1, imageHeight - h));
  return [x1, y1, x1 + w, y1 + h];
}
