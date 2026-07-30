import {
  isEffectRevealStyle,
  isHandRevealStyle,
  type WhiteboardHandStyle,
  type WhiteboardObject,
  type WhiteboardRevealStyle,
  type WhiteboardSceneJson,
} from "./whiteboard-scene";

export interface PathPoint {
  x: number;
  y: number;
}

export interface ObjectPath {
  objectId: string;
  type: WhiteboardObject["type"];
  bbox: [number, number, number, number];
  /** Reveal style used by Remotion (hand path or effect). */
  revealStyle: WhiteboardRevealStyle;
  /** Points that the brush travels along while erasing the mask (draw phase). Empty for effects. */
  drawPoints: PathPoint[];
  /** Estimated duration of the draw/effect phase in seconds. */
  drawDurationSec: number;
  /** Transit duration before drawing starts (hand moving from previous endpoint). */
  transitDurationSec: number;
  /** Separate SVG strokes used by Remotion for stroke-then-fill rendering. */
  strokePaths?: PathPoint[][];
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

/** Fixed duration range for non-hand effects. */
const EFFECT_DURATION_MIN_SEC = 0.55;
const EFFECT_DURATION_MAX_SEC = 1.4;
const EFFECT_TRANSIT_SEC = 0.18;

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
      const revealStyle = WhiteboardPathPlanner.resolveRevealStyle(obj);
      const cx = (x1 + x2) / 2;
      const cy = (y1 + y2) / 2;

      let drawPoints: PathPoint[];
      let drawDurationSec: number;
      let transitDurationSec: number;

      if (isEffectRevealStyle(revealStyle)) {
        drawPoints = [{ x: Math.round(cx), y: Math.round(cy) }];
        drawDurationSec = WhiteboardPathPlanner.effectDurationSec(x2 - x1, y2 - y1);
        transitDurationSec = EFFECT_TRANSIT_SEC;
      } else if (revealStyle === "svg_stroke_fill" && obj.strokePaths?.length) {
        const strokePaths = obj.strokePaths.map((path) =>
          path.map(([x, y]) => ({ x, y })),
        );
        drawPoints = strokePaths.flat();
        const drawLength = strokePaths.reduce(
          (sum, path) => sum + WhiteboardPathPlanner.pathLength(path),
          0,
        );
        drawDurationSec =
          Number.isFinite(obj.durationSec) && Number(obj.durationSec) > 0
            ? Math.min(60, Math.max(0.1, Number(obj.durationSec)))
            : Math.max(0.5, drawLength / brushSpeedPx);
        const transitDist = WhiteboardPathPlanner.dist(
          prevEndPoint,
          drawPoints[0] ?? { x: x1, y: y1 },
        );
        transitDurationSec = Math.max(0, transitDist / TRANSIT_SPEED_PX);
        prevEndPoint = drawPoints[drawPoints.length - 1] ?? { x: x2, y: y2 };
        objectPaths.push({
          objectId: obj.id,
          type: obj.type,
          bbox: obj.bbox,
          revealStyle,
          drawPoints,
          drawDurationSec,
          transitDurationSec,
          strokePaths,
        });
        continue;
      } else {
        drawPoints = WhiteboardPathPlanner.buildDrawPoints(
          obj.type,
          x1,
          y1,
          x2,
          y2,
          brushSize,
          revealStyle as WhiteboardHandStyle,
        );
        const drawLength = WhiteboardPathPlanner.pathLength(drawPoints);
        drawDurationSec =
          Number.isFinite(obj.durationSec) && Number(obj.durationSec) > 0
            ? Math.min(60, Math.max(0.1, Number(obj.durationSec)))
            : Math.max(0.1, drawLength / brushSpeedPx);
        const transitDist = WhiteboardPathPlanner.dist(
          prevEndPoint,
          drawPoints[0] ?? { x: x1, y: y1 },
        );
        transitDurationSec = Math.max(0, transitDist / TRANSIT_SPEED_PX);
        prevEndPoint = drawPoints[drawPoints.length - 1] ?? { x: x2, y: y2 };
      }

      objectPaths.push({
        objectId: obj.id,
        type: obj.type,
        bbox: obj.bbox,
        revealStyle,
        drawPoints,
        drawDurationSec,
        transitDurationSec,
      });
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

  private static resolveRevealStyle(obj: WhiteboardObject): WhiteboardRevealStyle {
    if (obj.revealStyle) return obj.revealStyle;
    // Heuristic default for legacy objects without an explicit style.
    const [x1, y1, x2, y2] = obj.bbox;
    const w = x2 - x1;
    const h = y2 - y1;
    if (obj.type === "arrow" || obj.type === "text" || obj.type === "icon" || (w < 100 && h < 100)) {
      return "left_right";
    }
    const aspect = w / Math.max(1, h);
    if (aspect > 2) return "left_right";
    if (aspect < 0.5) return "top_bottom";
    return "zigzag";
  }

  private static effectDurationSec(width: number, height: number): number {
    const area = Math.max(1, width * height);
    // Larger boxes take a bit longer; clamp to a readable range.
    const scaled = 0.45 + Math.sqrt(area) / 900;
    return Math.min(EFFECT_DURATION_MAX_SEC, Math.max(EFFECT_DURATION_MIN_SEC, scaled));
  }

  private static buildDrawPoints(
    type: WhiteboardObject["type"],
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
    handStyle?: WhiteboardHandStyle,
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

    if (handStyle && isHandRevealStyle(handStyle)) {
      return WhiteboardPathPlanner.pointsForStyle(handStyle, cx1, cy1, cx2, cy2, brushSize);
    }

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
      return WhiteboardPathPlanner.horizontalSweep(cx1, cy1, cx2, cy2);
    }
    if (aspect < 0.5) {
      return WhiteboardPathPlanner.verticalSweep(cx1, cy1, cx2, cy2);
    }
    return WhiteboardPathPlanner.zigzag(cx1, cy1, cx2, cy2, brushSize);
  }

  private static pointsForStyle(
    style: WhiteboardHandStyle,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
  ): PathPoint[] {
    switch (style) {
      case "left_right":
        return WhiteboardPathPlanner.directionalRows(x1, y1, x2, y2, brushSize, "ltr");
      case "right_left":
        return WhiteboardPathPlanner.directionalRows(x1, y1, x2, y2, brushSize, "rtl");
      case "top_bottom":
        return WhiteboardPathPlanner.directionalColumns(x1, y1, x2, y2, brushSize);
      case "zigzag":
      default:
        return WhiteboardPathPlanner.zigzag(x1, y1, x2, y2, brushSize);
    }
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

  /**
   * Zigzag raster made of parallel 45° diagonal strokes.
   * Lines follow y = k - x ("/" direction) and are clipped to the bounding rectangle.
   */
  private static zigzag(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
  ): PathPoint[] {
    const perpendicularSpacing = Math.max(4, brushSize * ZIGZAG_ROW_FACTOR);
    // For x + y = k, changing k by d moves the line d / sqrt(2) perpendicularly.
    const kStep = perpendicularSpacing * Math.SQRT2;
    const minK = x1 + y1;
    const maxK = x2 + y2;
    const points: PathPoint[] = [];
    let strokeIndex = 0;

    for (let k = minK; k <= maxK + kStep / 2; k += kStep) {
      const clampedK = Math.min(k, maxK);
      const startX = Math.max(x1, clampedK - y2);
      const endX = Math.min(x2, clampedK - y1);
      if (endX < startX) continue;

      const start = { x: Math.round(startX), y: Math.round(clampedK - startX) };
      const end = { x: Math.round(endX), y: Math.round(clampedK - endX) };
      if (strokeIndex % 2 === 0) {
        points.push(start, end);
      } else {
        points.push(end, start);
      }
      strokeIndex++;
    }

    return points;
  }

  /** Fill rows in a fixed horizontal direction (no reverse). */
  private static directionalRows(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
    direction: "ltr" | "rtl",
  ): PathPoint[] {
    const rowSpacing = Math.max(4, brushSize * ZIGZAG_ROW_FACTOR);
    const points: PathPoint[] = [];
    let y = y1;
    while (y <= y2 + rowSpacing / 2) {
      const clampedY = Math.min(y, y2);
      if (direction === "ltr") {
        points.push({ x: Math.round(x1), y: Math.round(clampedY) });
        points.push({ x: Math.round(x2), y: Math.round(clampedY) });
      } else {
        points.push({ x: Math.round(x2), y: Math.round(clampedY) });
        points.push({ x: Math.round(x1), y: Math.round(clampedY) });
      }
      y += rowSpacing;
    }
    return points;
  }

  /** Fill columns top→bottom. */
  private static directionalColumns(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    brushSize: number,
  ): PathPoint[] {
    const colSpacing = Math.max(4, brushSize * ZIGZAG_ROW_FACTOR);
    const points: PathPoint[] = [];
    let x = x1;
    while (x <= x2 + colSpacing / 2) {
      const clampedX = Math.min(x, x2);
      points.push({ x: Math.round(clampedX), y: Math.round(y1) });
      points.push({ x: Math.round(clampedX), y: Math.round(y2) });
      x += colSpacing;
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
        const start = op.drawPoints[0] ?? { x: op.bbox[0], y: op.bbox[1] };
        return { x: start.x, y: start.y, drawing: false };
      }
      if (tSec <= drawEnd) {
        const drawT = op.drawDurationSec > 0 ? (tSec - transitEnd) / op.drawDurationSec : 1;
        const pos = WhiteboardPathPlanner.interpolatePath(op.drawPoints, drawT);
        return { ...pos, drawing: true };
      }

      elapsed = drawEnd;
    }

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
