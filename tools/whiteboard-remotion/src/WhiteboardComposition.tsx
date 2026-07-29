import React, { useCallback, useEffect, useRef } from "react";
import { useCurrentFrame, useVideoConfig, staticFile } from "remotion";

/** Hand pen-tip offset relative to hand PNG top-left corner (as fraction of hand image dimensions). */
const HAND_TIP_OFFSET_X = 0.18;
const HAND_TIP_OFFSET_Y = 0.08;

/** Hand image displayed size (px in output video). */
const HAND_DISPLAY_WIDTH = 120;
const HAND_DISPLAY_HEIGHT = 120;

export interface PathPoint {
  x: number;
  y: number;
}

export interface ObjectPath {
  objectId: string;
  bbox: [number, number, number, number];
  drawPoints: PathPoint[];
  drawDurationSec: number;
  transitDurationSec: number;
}

export interface WhiteboardPathPlan {
  totalDurationSec: number;
  fps: number;
  brushSize: number;
  brushSpeedPx: number;
  objectPaths: ObjectPath[];
}

export interface WhiteboardCompositionProps {
  /** Base64-encoded composite image or data: URL. */
  sourceImageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  pathPlan: WhiteboardPathPlan;
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

/**
 * Returns all (point, isDrawing) pairs that have been traversed up to time tSec,
 * plus the current hand position.
 */
function computeFrameState(plan: WhiteboardPathPlan, tSec: number) {
  const strokesDrawn: { points: PathPoint[]; brushSize: number }[] = [];
  let handPos: PathPoint = { x: 0, y: 0 };

  let elapsed = 0;
  for (const op of plan.objectPaths) {
    const transitEnd = elapsed + op.transitDurationSec;
    const drawEnd = transitEnd + op.drawDurationSec;

    if (tSec < elapsed) break;

    if (tSec >= drawEnd) {
      // Entire object has been drawn — include full stroke
      strokesDrawn.push({ points: op.drawPoints, brushSize: plan.brushSize });
      handPos = op.drawPoints[op.drawPoints.length - 1] ?? handPos;
    } else if (tSec >= transitEnd) {
      // Currently drawing this object
      const drawT = op.drawDurationSec > 0 ? (tSec - transitEnd) / op.drawDurationSec : 1;
      const partialPoint = interpolatePath(op.drawPoints, drawT);

      // Build partial stroke: all points up to the interpolated position
      const partialPoints: PathPoint[] = [];
      let totalLen = 0;
      for (let i = 1; i < op.drawPoints.length; i++) {
        const dx = op.drawPoints[i].x - op.drawPoints[i - 1].x;
        const dy = op.drawPoints[i].y - op.drawPoints[i - 1].y;
        totalLen += Math.sqrt(dx * dx + dy * dy);
      }
      let pathLen = 0;
      let prevLen = 0;
      const targetLen = totalLen * drawT;
      partialPoints.push(op.drawPoints[0]);
      for (let i = 1; i < op.drawPoints.length; i++) {
        const dx = op.drawPoints[i].x - op.drawPoints[i - 1].x;
        const dy = op.drawPoints[i].y - op.drawPoints[i - 1].y;
        const seg = Math.sqrt(dx * dx + dy * dy);
        if (prevLen + seg >= targetLen) {
          partialPoints.push(partialPoint);
          break;
        }
        prevLen += seg;
        partialPoints.push(op.drawPoints[i]);
      }

      strokesDrawn.push({ points: partialPoints, brushSize: plan.brushSize });
      handPos = partialPoint;
    } else if (tSec >= elapsed) {
      // Transit phase — move toward first draw point
      const firstPt = op.drawPoints[0] ?? { x: op.bbox[0], y: op.bbox[1] };
      handPos = firstPt;
    }

    elapsed = drawEnd;
  }

  return { strokesDrawn, handPos };
}

export const WhiteboardComposition: React.FC<WhiteboardCompositionProps> = ({
  sourceImageDataUrl,
  imageWidth,
  imageHeight,
  pathPlan,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceImgRef = useRef<HTMLImageElement | null>(null);
  const handImgRef = useRef<HTMLImageElement | null>(null);

  // Load source image once
  useEffect(() => {
    const img = new Image();
    img.onload = () => { sourceImgRef.current = img; };
    img.src = sourceImageDataUrl;

    const hand = new Image();
    hand.onload = () => { handImgRef.current = hand; };
    hand.onerror = () => {
      // Try SVG fallback
      const handSvg = new Image();
      handSvg.onload = () => { handImgRef.current = handSvg; };
      handSvg.src = staticFile("whiteboard-hand.svg");
    };
    hand.src = staticFile("whiteboard-hand.png");
  }, [sourceImageDataUrl]);

  const renderFrame = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const tSec = frame / fps;
    const { strokesDrawn, handPos } = computeFrameState(pathPlan, tSec);

    // --- Layer 1: white background ---
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, imageWidth, imageHeight);

    // --- Layer 2: composite image ---
    if (sourceImgRef.current) {
      ctx.drawImage(sourceImgRef.current, 0, 0, imageWidth, imageHeight);
    }

    // --- Layer 3: white mask (off-screen) then composite ---
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = imageWidth;
    maskCanvas.height = imageHeight;
    const maskCtx = maskCanvas.getContext("2d")!;

    // Fill mask white
    maskCtx.fillStyle = "#ffffff";
    maskCtx.fillRect(0, 0, imageWidth, imageHeight);

    // Erase (destination-out) the areas that have been "drawn"
    maskCtx.globalCompositeOperation = "destination-out";
    for (const stroke of strokesDrawn) {
      if (stroke.points.length === 0) continue;
      maskCtx.beginPath();
      maskCtx.lineWidth = stroke.brushSize;
      maskCtx.lineCap = "round";
      maskCtx.lineJoin = "round";
      // Stroke alpha = 1 ensures full erase
      maskCtx.strokeStyle = "rgba(0,0,0,1)";

      if (stroke.points.length === 1) {
        maskCtx.arc(stroke.points[0].x, stroke.points[0].y, stroke.brushSize / 2, 0, Math.PI * 2);
        maskCtx.fill();
      } else {
        maskCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
        for (let i = 1; i < stroke.points.length; i++) {
          maskCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
        }
        maskCtx.stroke();
      }
    }
    maskCtx.globalCompositeOperation = "source-over";

    // Draw the mask on top of the image (white parts hide image)
    ctx.drawImage(maskCanvas, 0, 0);

    // --- Layer 4: hand ---
    if (handImgRef.current) {
      const tipX = HAND_TIP_OFFSET_X * HAND_DISPLAY_WIDTH;
      const tipY = HAND_TIP_OFFSET_Y * HAND_DISPLAY_HEIGHT;
      ctx.drawImage(
        handImgRef.current,
        handPos.x - tipX,
        handPos.y - tipY,
        HAND_DISPLAY_WIDTH,
        HAND_DISPLAY_HEIGHT,
      );
    }
  }, [frame, fps, pathPlan, imageWidth, imageHeight]);

  useEffect(() => {
    renderFrame();
  });

  return (
    <canvas
      ref={canvasRef}
      width={imageWidth}
      height={imageHeight}
      style={{ display: "block", width: imageWidth, height: imageHeight }}
    />
  );
};
