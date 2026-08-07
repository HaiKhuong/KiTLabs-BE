import { WhiteboardPathPlanner } from "./whiteboard-path-planner";
import type { WhiteboardSceneJson } from "./whiteboard-scene";

function makeScene(
  id: string,
  type: "text" | "image",
  bbox: [number, number, number, number],
): WhiteboardSceneJson {
  return {
    imageWidth: 1280,
    imageHeight: 720,
    objects: [{ id, type, bbox, order: 1 }],
  };
}

describe("WhiteboardPathPlanner.plan", () => {
  const config = {};

  it("produces left-to-right hand_write columns for text", () => {
    const scene = makeScene("title", "text", [100, 50, 900, 150]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.objectPaths).toHaveLength(1);
    expect(plan.objectPaths[0].revealStyle).toBe("hand_write");
    const points = plan.objectPaths[0].drawPoints;
    expect(points.length).toBeGreaterThan(2);
    // First column should start near the left of the bbox.
    expect(points[0].x).toBeLessThan(100 + 80);
    // Vertical inset: top closer to bbox top than bottom is to bbox bottom.
    const ys = points.map((p) => p.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    expect(minY - 50).toBeLessThan(150 - maxY);
    for (const pt of points) {
      expect(pt.x).toBeGreaterThanOrEqual(100 - 1);
      expect(pt.x).toBeLessThanOrEqual(900 + 1);
      expect(pt.y).toBeGreaterThanOrEqual(50 - 1);
      expect(pt.y).toBeLessThanOrEqual(150 + 1);
    }
  });

  it("produces zigzag points for large square image", () => {
    const scene = makeScene("infographic", "image", [0, 0, 800, 600]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const op = plan.objectPaths[0];
    // Diagonal zigzag produces many clipped strokes.
    expect(op.drawPoints.length).toBeGreaterThan(6);
    const diagonalSegments = op.drawPoints.filter((_, index) => index % 2 === 0).map((point, index) => {
      const next = op.drawPoints[index * 2 + 1];
      return next ? Math.abs(Math.abs(next.x - point.x) - Math.abs(next.y - point.y)) : Infinity;
    });
    expect(diagonalSegments.some((delta) => delta <= 2)).toBe(true);
  });

  it("produces vertical sweep for very tall image (aspect < 0.5)", () => {
    const scene = makeScene("tall_img", "image", [100, 50, 200, 600]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const op = plan.objectPaths[0];
    expect(op.drawPoints.length).toBeGreaterThan(0);
    // Vertical sweep: x values differ, y spans the bbox
    const ys = op.drawPoints.map((p) => p.y);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    expect(maxY - minY).toBeGreaterThan(100);
  });

  it("produces horizontal sweep for very wide image (aspect > 2)", () => {
    const scene = makeScene("wide_img", "image", [0, 200, 1200, 280]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const op = plan.objectPaths[0];
    const xs = op.drawPoints.map((p) => p.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(100);
  });

  it("totalDurationSec > 0 for any non-empty scene", () => {
    const scene = makeScene("icon", "image", [10, 10, 50, 50]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.totalDurationSec).toBeGreaterThan(0);
  });

  it("respects durationSec in engineConfig", () => {
    const scene = makeScene("title", "text", [100, 50, 900, 150]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, { durationSec: 5 });
    expect(Math.abs(plan.totalDurationSec - 5)).toBeLessThan(0.01);
  });

  it("handles multiple objects with correct order", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        { id: "b", type: "text", bbox: [100, 200, 400, 250], order: 2 },
        { id: "a", type: "text", bbox: [100, 50, 400, 100], order: 1 },
      ],
    };
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.objectPaths).toHaveLength(2);
    expect(plan.objectPaths[0].objectId).toBe("a");
    expect(plan.objectPaths[1].objectId).toBe("b");
  });

  it("delays overlapping later layer until earlier layer finishes", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        {
          id: "bottom",
          type: "image",
          bbox: [100, 100, 500, 400],
          order: 1,
          revealStyle: "fade_in",
          durationSec: 2,
        },
        {
          id: "top",
          type: "image",
          bbox: [200, 150, 600, 450],
          order: 2,
          revealStyle: "fade_in",
          durationSec: 2,
        },
      ],
    };
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const bottom = plan.objectPaths.find((p) => p.objectId === "bottom")!;
    const top = plan.objectPaths.find((p) => p.objectId === "top")!;
    expect(top.drawStartSec).toBeGreaterThanOrEqual(
      bottom.drawStartSec + bottom.drawDurationSec - 1e-6,
    );
  });

  it("respects explicit revealStyle left_right", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        {
          id: "img",
          type: "image",
          bbox: [0, 0, 400, 400],
          order: 1,
          revealStyle: "left_right",
        },
      ],
    };
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const points = plan.objectPaths[0].drawPoints;
    expect(points.length).toBeGreaterThan(2);
    // First segment of each row should start on the left edge
    expect(points[0].x).toBeLessThan(points[1].x);
  });

  it("plans effect styles without brush strokes", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        {
          id: "img",
          type: "image",
          bbox: [100, 100, 500, 400],
          order: 1,
          revealStyle: "zoom_in",
        },
      ],
    };
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.objectPaths[0].revealStyle).toBe("zoom_in");
    expect(plan.objectPaths[0].drawPoints).toHaveLength(1);
    expect(plan.objectPaths[0].drawDurationSec).toBeGreaterThan(0.4);
  });

  it("uses per-object durationSec for hand styles", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        {
          id: "timed",
          type: "image",
          bbox: [100, 100, 500, 400],
          order: 1,
          revealStyle: "zigzag",
          durationSec: 4.5,
        },
      ],
    };
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.objectPaths[0].drawDurationSec).toBe(4.5);
  });

  it("uses sampled SVG strokes for stroke-then-fill paths", () => {
    const scene: WhiteboardSceneJson = {
      imageWidth: 1280,
      imageHeight: 720,
      objects: [
        {
          id: "vector",
          type: "image",
          bbox: [100, 100, 500, 400],
          order: 1,
          revealStyle: "svg_stroke_fill",
          durationSec: 3,
          strokePaths: [
            [[100, 100], [300, 200], [500, 100]],
            [[200, 300], [400, 300]],
          ],
        },
      ],
    };

    const op = WhiteboardPathPlanner.plan(scene, 1280, 720, config).objectPaths[0];
    expect(op.revealStyle).toBe("svg_stroke_fill");
    expect(op.strokePaths).toHaveLength(2);
    expect(op.drawPoints).toHaveLength(5);
    expect(op.drawDurationSec).toBe(3);
  });
});

describe("WhiteboardPathPlanner.interpolate", () => {
  it("returns starting position at t=0", () => {
    const scene = makeScene("title", "text", [100, 50, 900, 100]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, {});
    const pos = WhiteboardPathPlanner.interpolate(plan, 0);
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
  });

  it("returns a position with drawing=true inside a draw phase", () => {
    const scene = makeScene("title", "text", [100, 50, 900, 100]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, {});
    const op = plan.objectPaths[0];
    const tMid = op.transitDurationSec + op.drawDurationSec * 0.5;
    const pos = WhiteboardPathPlanner.interpolate(plan, tMid);
    expect(pos.drawing).toBe(true);
  });
});
