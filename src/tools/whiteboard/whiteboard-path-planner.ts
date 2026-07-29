import type { WhiteboardObject, WhiteboardSceneJson } from "./whiteboard-vision.service";

export interface PathPoint {
  x: number;
  y: number;
}

export interface ObjectPath {
  objectId: string;
  type: WhiteboardObject["type"];
  bbox: [number, number, number, number];
  /** Points that the brush travels along while erasing the mask (draw phase). */
  drawPoints: PathPoint[];
  /** Estimated duration of the draw phase in seconds. */
  drawDurationSec: number;
  /** Transit duration before drawing starts (hand moving from previous endpoint). */
  transitDurationSec: number;
}

export interface WhiteboardPathPlan {
  totalDurationSec: number;
  fps: number;
  brushSize: number;
  brushSpeedPx: number;
  objectPaths: ObjectPath[];
}

/** Pixels per second the brush travels while drawing (default). */
const DEFAULT_BRUSH_SPEED_PX = 600;

/** Pixels per second the hand moves between objects (faster). */
const TRANSIT_SPEED_PX = 1800;

const DEFAULT_BRUSH_SIZE = 60;
const DEFAULT_FPS = 30;

/** Minimum zigzag row spacing relative to brush size. */
const ZIGZAG_ROW_FACTOR = 0.7;

export class WhiteboardPathPlanner {
  static plan(
    sceneJson: WhiteboardSceneJson,
    imageWidth: number,
    imageHeight: number,
    engineConfig: Record<string, unknown>,
  ): WhiteboardPathPlan {
    const brushSize = Number(engineConfig.brushSize ?? DEFAULT_BRUSH_SIZE);
    const brushSpeedPx = Number(engineConfig.brushSpeedPx ?? DEFAULT_BRUSH_SPEED_PX);
    const fps = Number(engineConfig.fps ?? DEFAULT_FPS);
    const maxDurationSec = Number(engineConfig.durationSec ?? 0);

    const objects = [...sceneJson.objects].sort(
      (a, b) => a.order - b.order || a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0],
    );

    const objectPaths: ObjectPath[] = [];
    let prevEndPoint: PathPoint = { x: 0, y: 0 };

    for (const obj of objects) {
      const [x1, y1, x2, y2] = obj.bbox;
      const w = x2 - x1;
      const h = y2 - y1;
      const drawPoints = WhiteboardPathPlanner.buildDrawPoints(obj.type, x1, y1, x2, y2, brushSize);

      const drawLength = WhiteboardPathPlanner.pathLength(drawPoints);
      const drawDurationSec = drawLength / brushSpeedPx;

      const transitDist = WhiteboardPathPlanner.dist(prevEndPoint, drawPoints[0] ?? { x: x1, y: y1 });
      const transitDurationSec = transitDist / TRANSIT_SPEED_PX;

      objectPaths.push({
        objectId: obj.id,
        type: obj.type,
        bbox: obj.bbox,
        drawPoints,
        drawDurationSec: Math.max(0.1, drawDurationSec),
        transitDurationSec: Math.max(0, transitDurationSec),
      });

      prevEndPoint = drawPoints[drawPoints.length - 1] ?? { x: x2, y: y2 };
    }

    let totalDurationSec = objectPaths.reduce(
      (sum, p) => sum + p.drawDurationSec + p.transitDurationSec,
      0,
    );

    // If user specified a duration, scale proportionally
    if (maxDurationSec > 0 && totalDurationSec > 0) {
      const scale = maxDurationSec / totalDurationSec;
      for (const p of objectPaths) {
        p.drawDurationSec *= scale;
        p.transitDurationSec *= scale;
      }
      totalDurationSec = maxDurationSec;
    }

    return { totalDurationSec, fps, brushSize, brushSpeedPx, objectPaths };
  }

  private static buildDrawPoints(
    type: WhiteboardObject["type"],
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
  ): PathPoint[] {
    const w = x2 - x1;
    const h = y2 - y1;

    const margin = brushSize * 0.4;
    const bx1 = x1 + margin;
    const by1 = y1 + margin;
    const bx2 = x2 - margin;
    const by2 = y2 - margin;

    // Clamp so we always have at least a single point inside
    const cx1 = Math.min(bx1, (x1 + x2) / 2);
    const cy1 = Math.min(by1, (y1 + y2) / 2);
    const cx2 = Math.max(bx2, (x1 + x2) / 2);
    const cy2 = Math.max(by2, (y1 + y2) / 2);

    // Strategy selection
    if (type === "arrow") {
      return WhiteboardPathPlanner.horizontalSweep(cx1, cy1, cx2, cy2);
    }
    if (type === "icon" || (w < 100 && h < 100)) {
      return WhiteboardPathPlanner.horizontalSweep(cx1, cy1, cx2, cy2);
    }
    if (type === "text") {
      return WhiteboardPathPlanner.horizontalSweep(cx1, cy1, cx2, cy2);
    }
    // Large image
    const aspect = w / h;
    if (aspect > 2) {
      // Very wide: left-to-right single pass
      return WhiteboardPathPlanner.horizontalSweep(cx1, cy1, cx2, cy2);
    }
    if (aspect < 0.5) {
      // Very tall: top-to-bottom
      return WhiteboardPathPlanner.verticalSweep(cx1, cy1, cx2, cy2);
    }
    // Large square-ish: zigzag
    return WhiteboardPathPlanner.zigzag(cx1, cy1, cx2, cy2, brushSize);
  }

  /** Horizontal sweep: left→right at midpoint y. For multi-line text, adds rows. */
  private static horizontalSweep(x1: number, y1: number, x2: number, y2: number): PathPoint[] {
    const points: PathPoint[] = [];
    const h = y2 - y1;
    const rowSpacing = 24;
    const rows = Math.max(1, Math.round(h / rowSpacing));
    for (let r = 0; r < rows; r++) {
      const y = y1 + (r + 0.5) * (h / rows);
      if (r % 2 === 0) {
        points.push({ x: x1, y: Math.round(y) }, { x: x2, y: Math.round(y) });
      } else {
        points.push({ x: x2, y: Math.round(y) }, { x: x1, y: Math.round(y) });
      }
    }
    return points;
  }

  /** Vertical sweep: top→bottom at midpoint x. */
  private static verticalSweep(x1: number, y1: number, x2: number, y2: number): PathPoint[] {
    const points: PathPoint[] = [];
    const w = x2 - x1;
    const colSpacing = 24;
    const cols = Math.max(1, Math.round(w / colSpacing));
    for (let c = 0; c < cols; c++) {
      const x = x1 + (c + 0.5) * (w / cols);
      if (c % 2 === 0) {
        points.push({ x: Math.round(x), y: y1 }, { x: Math.round(x), y: y2 });
      } else {
        points.push({ x: Math.round(x), y: y2 }, { x: Math.round(x), y: y1 });
      }
    }
    return points;
  }

  /** Zigzag raster: fills a bounding box with alternating horizontal rows. */
  private static zigzag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
  ): PathPoint[] {
    const rowSpacing = Math.max(4, brushSize * ZIGZAG_ROW_FACTOR);
    const points: PathPoint[] = [];
    let y = y1;
    let rowIdx = 0;
    while (y <= y2 + rowSpacing / 2) {
      const clampedY = Math.min(y, y2);
      if (rowIdx % 2 === 0) {
        points.push({ x: Math.round(x1), y: Math.round(clampedY) });
        points.push({ x: Math.round(x2), y: Math.round(clampedY) });
      } else {
        points.push({ x: Math.round(x2), y: Math.round(clampedY) });
        points.push({ x: Math.round(x1), y: Math.round(clampedY) });
      }
      y += rowSpacing;
      rowIdx++;
    }
    return points;
  }

  static pathLength(points: PathPoint[]): number {
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += WhiteboardPathPlanner.dist(points[i - 1], points[i]);
    }
    return len;
  }

  static dist(a: PathPoint, b: PathPoint): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Given a path plan and a time t (seconds), return the current brush position
   * and whether we're in draw or transit phase.
   */
  static interpolate(
    plan: WhiteboardPathPlan,
    tSec: number,
  ): { x: number; y: number; drawing: boolean } {
    let elapsed = 0;
    for (const op of plan.objectPaths) {
      const transitEnd = elapsed + op.transitDurationSec;
      const drawEnd = transitEnd + op.drawDurationSec;

      if (tSec <= transitEnd) {
        // Transit phase — linear interpolation from previous end to first draw point
        const t = op.transitDurationSec > 0 ? (tSec - elapsed) / op.transitDurationSec : 1;
        const start = op.drawPoints[0] ?? { x: op.bbox[0], y: op.bbox[1] };
        return { x: start.x, y: start.y, drawing: false };
      }
      if (tSec <= drawEnd) {
        // Draw phase
        const drawT = op.drawDurationSec > 0 ? (tSec - transitEnd) / op.drawDurationSec : 1;
        const pos = WhiteboardPathPlanner.interpolatePath(op.drawPoints, drawT);
        return { ...pos, drawing: true };
      }

      elapsed = drawEnd;
    }

    // Past the end — stay at last point
    const lastPath = plan.objectPaths[plan.objectPaths.length - 1];
    if (lastPath) {
      const last = lastPath.drawPoints[lastPath.drawPoints.length - 1];
      if (last) return { ...last, drawing: false };
    }
    return { x: 0, y: 0, drawing: false };
  }

  private static interpolatePath(points: PathPoint[], t: number): PathPoint {
    if (points.length === 0) return { x: 0, y: 0 };
    if (points.length === 1) return points[0];
    if (t <= 0) return points[0];
    if (t >= 1) return points[points.length - 1];

    const totalLen = WhiteboardPathPlanner.pathLength(points);
    const target = totalLen * t;
    let acc = 0;
    for (let i = 1; i < points.length; i++) {
      const seg = WhiteboardPathPlanner.dist(points[i - 1], points[i]);
      if (acc + seg >= target) {
        const segT = seg > 0 ? (target - acc) / seg : 0;
        return {
          x: Math.round(points[i - 1].x + (points[i].x - points[i - 1].x) * segT),
          y: Math.round(points[i - 1].y + (points[i].y - points[i - 1].y) * segT),
        };
      }
      acc += seg;
    }
    return points[points.length - 1];
  }
}
