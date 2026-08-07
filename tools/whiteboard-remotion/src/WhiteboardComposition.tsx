import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Audio,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

/** Hand pen-tip offset relative to hand PNG top-left corner (as fraction of hand image dimensions). */
const HAND_TIP_OFFSET_X = 0;
const HAND_TIP_OFFSET_Y = 0.2;

/** Hand image displayed size (px in output video). */
const HAND_DISPLAY_WIDTH = 480;
const HAND_DISPLAY_HEIGHT = 480;

const HAND_STYLES = new Set([
  "hand_write",
  "zigzag",
  "left_right",
  "right_left",
  "top_bottom",
  "svg_stroke_fill",
]);
const EFFECT_STYLES = new Set(["zoom_in", "fade_in", "slide_up", "pop"]);
/** Absolute fill fade after stroke completes — keeps fill snappy for long stroke times. */
const SVG_FILL_DURATION_SEC = 0.22;
const SVG_MIN_STROKE_PORTION = 0.7;

function svgStrokePortion(drawDurationSec: number): number {
  if (!(drawDurationSec > 0)) return 0.9;
  const fillPortion = Math.min(1 - SVG_MIN_STROKE_PORTION, SVG_FILL_DURATION_SEC / drawDurationSec);
  return clamp01(1 - fillPortion);
}

export interface PathPoint {
  x: number;
  y: number;
}

export interface ObjectPath {
  objectId: string;
  bbox: [number, number, number, number];
  order?: number;
  revealStyle?: string;
  drawPoints: PathPoint[];
  drawDurationSec: number;
  transitDurationSec: number;
  drawStartSec?: number;
  strokePaths?: PathPoint[][];
}

export interface WhiteboardPathPlan {
  totalDurationSec: number;
  fps: number;
  brushSize: number;
  brushSpeedPx: number;
  objectPaths: ObjectPath[];
}

export interface WhiteboardAudioCue {
  srcDataUrl: string;
  startFrame: number;
  durationSec: number;
}

export type WhiteboardCameraKeyframe = {
  atSec: number;
  bbox: [number, number, number, number];
};

export type WhiteboardCameraPlan = {
  keyframes: WhiteboardCameraKeyframe[];
};

export interface WhiteboardCompositionProps {
  /** Base64-encoded composite image or data: URL. */
  sourceImageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  pathPlan: WhiteboardPathPlan;
  audioCues?: WhiteboardAudioCue[];
  /** Optional custom hand image as data URL; falls back to bundled static hand. */
  handImageDataUrl?: string | null;
  /** Per-object isolated layer PNGs for correct overlap z-order. */
  objectLayerSourceDataUrls?: Record<string, string>;
  /** Optional camera zoom keyframes (view rect over time). */
  cameraPlan?: WhiteboardCameraPlan | null;
}

type ObjectFrameState = {
  op: ObjectPath;
  /** 0 = not started, (0,1) = in progress, 1 = done */
  progress: number;
  phase: "pending" | "transit" | "drawing" | "done";
  handPos: PathPoint | null;
  partialPoints: PathPoint[];
  partialStrokePaths: PathPoint[][];
};

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${src.slice(0, 64)}`));
    img.src = src;
  });
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function interpolateCameraBbox(
  plan: WhiteboardCameraPlan | null | undefined,
  tSec: number,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  const full: [number, number, number, number] = [0, 0, imageWidth, imageHeight];
  const keyframes = plan?.keyframes;
  if (!keyframes || keyframes.length === 0) return full;

  const sorted = [...keyframes].sort((a, b) => a.atSec - b.atSec);
  if (tSec <= sorted[0].atSec) return [...sorted[0].bbox] as [number, number, number, number];
  const last = sorted[sorted.length - 1];
  if (tSec >= last.atSec) return [...last.bbox] as [number, number, number, number];

  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (tSec > b.atSec) continue;
    const span = Math.max(1e-6, b.atSec - a.atSec);
    const u = easeInOutCubic((tSec - a.atSec) / span);
    return [
      lerp(a.bbox[0], b.bbox[0], u),
      lerp(a.bbox[1], b.bbox[1], u),
      lerp(a.bbox[2], b.bbox[2], u),
      lerp(a.bbox[3], b.bbox[3], u),
    ];
  }
  return [...last.bbox] as [number, number, number, number];
}

function applyCameraTransform(
  ctx: CanvasRenderingContext2D,
  view: [number, number, number, number],
  imageWidth: number,
  imageHeight: number,
): void {
  const [x1, y1, x2, y2] = view;
  const vw = Math.max(1, x2 - x1);
  const vh = Math.max(1, y2 - y1);
  const scaleX = imageWidth / vw;
  const scaleY = imageHeight / vh;
  ctx.setTransform(scaleX, 0, 0, scaleY, -x1 * scaleX, -y1 * scaleY);
}

/** Overshoot ease for pop. */
function easeOutBack(t: number): number {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

function interpolatePath(points: PathPoint[], t: number): PathPoint {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return points[0];
  if (t <= 0) return points[0];
  if (t >= 1) return points[points.length - 1];

  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalLen += Math.sqrt(dx * dx + dy * dy);
  }

  const target = totalLen * t;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const seg = Math.sqrt(dx * dx + dy * dy);
    if (acc + seg >= target) {
      const segT = seg > 0 ? (target - acc) / seg : 0;
      return {
        x: Math.round(points[i - 1].x + dx * segT),
        y: Math.round(points[i - 1].y + dy * segT),
      };
    }
    acc += seg;
  }
  return points[points.length - 1];
}

function buildPartialStroke(points: PathPoint[], drawT: number, partialPoint: PathPoint): PathPoint[] {
  if (points.length === 0) return [];
  if (points.length === 1 || drawT <= 0) return [points[0]];
  if (drawT >= 1) return points;

  let totalLen = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    totalLen += Math.sqrt(dx * dx + dy * dy);
  }

  const targetLen = totalLen * drawT;
  const partialPoints: PathPoint[] = [points[0]];
  let prevLen = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const seg = Math.sqrt(dx * dx + dy * dy);
    if (prevLen + seg >= targetLen) {
      partialPoints.push(partialPoint);
      break;
    }
    prevLen += seg;
    partialPoints.push(points[i]);
  }
  return partialPoints;
}

function strokePathsLength(paths: PathPoint[][]): number {
  return paths.reduce((sum, path) => {
    let length = 0;
    for (let index = 1; index < path.length; index++) {
      length += Math.hypot(path[index].x - path[index - 1].x, path[index].y - path[index - 1].y);
    }
    return sum + length;
  }, 0);
}

function buildPartialStrokePaths(
  paths: PathPoint[][],
  progress: number,
): { paths: PathPoint[][]; handPos: PathPoint | null } {
  const totalLength = strokePathsLength(paths);
  if (totalLength <= 0) return { paths: [], handPos: paths[0]?.[0] ?? null };

  let remaining = totalLength * clamp01(progress);
  const partial: PathPoint[][] = [];
  let handPos: PathPoint | null = paths[0]?.[0] ?? null;

  for (const path of paths) {
    if (path.length < 2) continue;
    const pathLength = strokePathsLength([path]);
    if (remaining >= pathLength) {
      partial.push(path);
      handPos = path[path.length - 1];
      remaining -= pathLength;
      continue;
    }

    const points: PathPoint[] = [path[0]];
    let consumed = 0;
    for (let index = 1; index < path.length; index++) {
      const previous = path[index - 1];
      const current = path[index];
      const segment = Math.hypot(current.x - previous.x, current.y - previous.y);
      if (consumed + segment >= remaining) {
        const segmentProgress = segment > 0 ? (remaining - consumed) / segment : 0;
        handPos = {
          x: previous.x + (current.x - previous.x) * segmentProgress,
          y: previous.y + (current.y - previous.y) * segmentProgress,
        };
        points.push(handPos);
        break;
      }
      points.push(current);
      handPos = current;
      consumed += segment;
    }
    partial.push(points);
    break;
  }

  return { paths: partial, handPos };
}

function isHandStyle(style: string | undefined): boolean {
  return Boolean(style && HAND_STYLES.has(style));
}

function isEffectStyle(style: string | undefined): boolean {
  return Boolean(style && EFFECT_STYLES.has(style));
}

function computeObjectStates(plan: WhiteboardPathPlan, tSec: number): ObjectFrameState[] {
  const states: ObjectFrameState[] = [];
  let elapsed = 0;

  for (const op of plan.objectPaths) {
    const hasAbsoluteStart = typeof op.drawStartSec === "number" && Number.isFinite(op.drawStartSec);
    const drawStart = hasAbsoluteStart
      ? Math.max(0, Number(op.drawStartSec))
      : elapsed + op.transitDurationSec;
    const transitStart = Math.max(0, drawStart - Math.max(0, op.transitDurationSec));
    const transitEnd = drawStart;
    const drawEnd = drawStart + op.drawDurationSec;
    const center = {
      x: Math.round((op.bbox[0] + op.bbox[2]) / 2),
      y: Math.round((op.bbox[1] + op.bbox[3]) / 2),
    };

    if (tSec < transitStart) {
      states.push({
        op,
        progress: 0,
        phase: "pending",
        handPos: null,
        partialPoints: [],
        partialStrokePaths: [],
      });
    } else if (tSec >= drawEnd) {
      states.push({
        op,
        progress: 1,
        phase: "done",
        handPos: op.drawPoints[op.drawPoints.length - 1] ?? center,
        partialPoints: op.drawPoints,
        partialStrokePaths: op.strokePaths ?? [],
      });
    } else if (tSec >= transitEnd) {
      const drawT = op.drawDurationSec > 0 ? (tSec - transitEnd) / op.drawDurationSec : 1;
      const strokePortion =
        op.revealStyle === "svg_stroke_fill" ? svgStrokePortion(op.drawDurationSec) : 1;
      const svgStrokeT =
        op.revealStyle === "svg_stroke_fill" ? clamp01(drawT / Math.max(0.001, strokePortion)) : drawT;
      const vectorState = op.strokePaths?.length
        ? buildPartialStrokePaths(op.strokePaths, svgStrokeT)
        : null;
      const partialPoint =
        vectorState?.handPos ?? interpolatePath(op.drawPoints, drawT);
      states.push({
        op,
        progress: clamp01(drawT),
        phase: "drawing",
        handPos: partialPoint,
        partialPoints: buildPartialStroke(op.drawPoints, drawT, partialPoint),
        partialStrokePaths: vectorState?.paths ?? [],
      });
    } else {
      states.push({
        op,
        progress: 0,
        phase: "transit",
        handPos: op.drawPoints[0] ?? center,
        partialPoints: [],
        partialStrokePaths: [],
      });
    }

    elapsed = Math.max(elapsed, drawEnd);
  }

  return states;
}

function eraseStroke(
  ctx: CanvasRenderingContext2D,
  points: PathPoint[],
  brushSize: number,
  offsetX = 0,
  offsetY = 0,
) {
  if (points.length === 0) return;
  ctx.beginPath();
  ctx.lineWidth = brushSize;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(0,0,0,1)";
  ctx.fillStyle = "rgba(0,0,0,1)";

  if (points.length === 1) {
    ctx.arc(points[0].x - offsetX, points[0].y - offsetY, brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  ctx.moveTo(points[0].x - offsetX, points[0].y - offsetY);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x - offsetX, points[i].y - offsetY);
  }
  ctx.stroke();
}

function drawHandReveal(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement,
  state: ObjectFrameState,
  brushSize: number,
) {
  const [x1, y1, x2, y2] = state.op.bbox;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);

  if (state.progress >= 1) {
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
    return;
  }
  if (state.partialPoints.length === 0) return;

  const temp = document.createElement("canvas");
  temp.width = w;
  temp.height = h;
  const tempCtx = temp.getContext("2d");
  if (!tempCtx) return;

  tempCtx.drawImage(source, x1, y1, w, h, 0, 0, w, h);

  const mask = document.createElement("canvas");
  mask.width = w;
  mask.height = h;
  const maskCtx = mask.getContext("2d");
  if (!maskCtx) return;

  maskCtx.fillStyle = "#ffffff";
  maskCtx.fillRect(0, 0, w, h);
  maskCtx.globalCompositeOperation = "destination-out";
  eraseStroke(maskCtx, state.partialPoints, brushSize, x1, y1);
  maskCtx.globalCompositeOperation = "source-over";

  tempCtx.drawImage(mask, 0, 0);
  ctx.drawImage(temp, x1, y1);
}

function drawSvgStrokeFill(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement,
  state: ObjectFrameState,
) {
  const [x1, y1, x2, y2] = state.op.bbox;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);

  if (state.progress >= 1) {
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
    return;
  }

  const strokePortion = svgStrokePortion(state.op.drawDurationSec);
  const fillProgress = easeOutCubic(
    clamp01((state.progress - strokePortion) / Math.max(0.001, 1 - strokePortion)),
  );
  if (fillProgress > 0) {
    ctx.save();
    ctx.globalAlpha = fillProgress;
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = "#171717";
  ctx.lineWidth = Math.max(2, Math.min(8, Math.min(w, h) * 0.012));
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const path of state.partialStrokePaths) {
    if (path.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(path[0].x, path[0].y);
    for (let index = 1; index < path.length; index++) {
      ctx.lineTo(path[index].x, path[index].y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawEffectReveal(
  ctx: CanvasRenderingContext2D,
  source: HTMLImageElement,
  state: ObjectFrameState,
) {
  if (state.progress <= 0) return;

  const [x1, y1, x2, y2] = state.op.bbox;
  const w = Math.max(1, x2 - x1);
  const h = Math.max(1, y2 - y1);
  const cx = x1 + w / 2;
  const cy = y1 + h / 2;
  const style = state.op.revealStyle ?? "zoom_in";
  const t = state.progress;

  ctx.save();

  if (style === "fade_in") {
    ctx.globalAlpha = easeOutCubic(t);
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
  } else if (style === "slide_up") {
    const eased = easeOutCubic(t);
    const offsetY = (1 - eased) * h * 0.45;
    ctx.beginPath();
    ctx.rect(x1, y1, w, h);
    ctx.clip();
    ctx.globalAlpha = Math.min(1, eased * 1.2);
    ctx.drawImage(source, x1, y1, w, h, x1, y1 + offsetY, w, h);
  } else if (style === "pop") {
    const scale = 0.2 + 0.8 * easeOutBack(t);
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
  } else {
    // zoom_in (default effect)
    const scale = 0.12 + 0.88 * easeOutCubic(t);
    ctx.translate(cx, cy);
    ctx.scale(scale, scale);
    ctx.translate(-cx, -cy);
    ctx.globalAlpha = Math.min(1, 0.35 + t * 0.9);
    ctx.drawImage(source, x1, y1, w, h, x1, y1, w, h);
  }

  ctx.restore();
}

export const WhiteboardComposition: React.FC<WhiteboardCompositionProps> = ({
  sourceImageDataUrl,
  imageWidth,
  imageHeight,
  pathPlan,
  audioCues = [],
  handImageDataUrl = null,
  objectLayerSourceDataUrls = {},
  cameraPlan = null,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceImgRef = useRef<HTMLImageElement | null>(null);
  const layerImgRef = useRef<Map<string, HTMLImageElement>>(new Map());
  const handImgRef = useRef<HTMLImageElement | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [handle] = useState(() => delayRender("Loading whiteboard assets"));

  useEffect(() => {
    let cancelled = false;

    const loadHand = async (): Promise<HTMLImageElement | null> => {
      if (handImageDataUrl) {
        try {
          return await loadImage(handImageDataUrl);
        } catch {
          // fall through to bundled default
        }
      }
      for (const name of ["whiteboard-hand.png", "whiteboard-hand.svg"]) {
        try {
          return await loadImage(staticFile(name));
        } catch {
          // try the next candidate
        }
      }
      return null;
    };

    const loadSource = sourceImageDataUrl
      ? loadImage(sourceImageDataUrl)
      : Promise.resolve(null);

    const loadLayerSources = async (): Promise<Map<string, HTMLImageElement>> => {
      const entries = Object.entries(objectLayerSourceDataUrls ?? {});
      const loaded = await Promise.all(
        entries.map(async ([objectId, src]) => {
          try {
            const img = await loadImage(src);
            return [objectId, img] as const;
          } catch {
            return null;
          }
        }),
      );
      return new Map(loaded.filter(Boolean) as Array<readonly [string, HTMLImageElement]>);
    };

    Promise.all([loadSource, loadHand(), loadLayerSources()])
      .then(([source, hand, layerSources]) => {
        if (cancelled) return;
        sourceImgRef.current = source;
        handImgRef.current = hand;
        layerImgRef.current = layerSources;
        setAssetsReady(true);
        continueRender(handle);
      })
      .catch((err) => {
        if (!cancelled) cancelRender(err);
      });

    return () => {
      cancelled = true;
      continueRender(handle);
    };
  }, [sourceImageDataUrl, handImageDataUrl, objectLayerSourceDataUrls, handle]);

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const compositeSource = sourceImgRef.current;
    const tSec = frame / fps;
    const states = computeObjectStates(pathPlan, tSec);
    const view = interpolateCameraBbox(cameraPlan, tSec, imageWidth, imageHeight);

    const resolveSource = (state: ObjectFrameState): HTMLImageElement | null => {
      const layerSource = layerImgRef.current.get(state.op.objectId);
      return layerSource ?? compositeSource;
    };

    const drawOrder = [...states].sort(
      (a, b) => (a.op.order ?? 0) - (b.op.order ?? 0),
    );

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, imageWidth, imageHeight);
    applyCameraTransform(ctx, view, imageWidth, imageHeight);

    for (const state of drawOrder) {
      if (state.progress <= 0 && state.phase !== "drawing") continue;
      const source = resolveSource(state);
      if (!source) continue;
      const style = state.op.revealStyle;
      if (style === "svg_stroke_fill" && state.op.strokePaths?.length) {
        drawSvgStrokeFill(ctx, source, state);
      } else if (isEffectStyle(style)) {
        drawEffectReveal(ctx, source, state);
      } else {
        // Hand styles (and legacy missing style) use brush reveal.
        drawHandReveal(ctx, source, state, pathPlan.brushSize);
      }
    }

    const active = [...states].reverse().find(
      (state) =>
        (state.phase === "drawing" || state.phase === "transit") &&
        isHandStyle(state.op.revealStyle ?? "zigzag") &&
        (state.op.revealStyle !== "svg_stroke_fill" ||
          state.phase === "transit" ||
          state.progress < svgStrokePortion(state.op.drawDurationSec)),
    );

    if (active?.handPos && handImgRef.current) {
      const tipX = HAND_TIP_OFFSET_X * HAND_DISPLAY_WIDTH;
      const tipY = HAND_TIP_OFFSET_Y * HAND_DISPLAY_HEIGHT;
      ctx.drawImage(
        handImgRef.current,
        active.handPos.x - tipX,
        active.handPos.y - tipY,
        HAND_DISPLAY_WIDTH,
        HAND_DISPLAY_HEIGHT,
      );
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [frame, fps, pathPlan, imageWidth, imageHeight, assetsReady, cameraPlan, objectLayerSourceDataUrls]);

  useEffect(() => {
    renderFrame();
  });

  return (
    <AbsoluteFill>
      <canvas
        ref={canvasRef}
        width={imageWidth}
        height={imageHeight}
        style={{ display: "block", width: imageWidth, height: imageHeight }}
      />
      {audioCues.map((cue, index) => (
        <Sequence key={`audio-${index}-${cue.startFrame}`} from={cue.startFrame}>
          <Audio src={cue.srcDataUrl} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
