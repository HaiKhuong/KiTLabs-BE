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

  it("produces drawPoints clamped inside bbox for text (horizontal sweep)", () => {
    const scene = makeScene("title", "text", [100, 50, 900, 100]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    expect(plan.objectPaths).toHaveLength(1);
    for (const pt of plan.objectPaths[0].drawPoints) {
      expect(pt.x).toBeGreaterThanOrEqual(100 - 1);
      expect(pt.x).toBeLessThanOrEqual(900 + 1);
      expect(pt.y).toBeGreaterThanOrEqual(50 - 1);
      expect(pt.y).toBeLessThanOrEqual(100 + 1);
    }
  });

  it("produces zigzag points for large square image", () => {
    const scene = makeScene("infographic", "image", [0, 0, 800, 600]);
    const plan = WhiteboardPathPlanner.plan(scene, 1280, 720, config);
    const op = plan.objectPaths[0];
    // zigzag produces many rows — more than 2 points
    expect(op.drawPoints.length).toBeGreaterThan(6);
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
