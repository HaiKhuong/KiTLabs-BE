import { normalizeSceneObjects, readSceneObjects } from "./whiteboard-scene";

const W = 1280;
const H = 720;

describe("normalizeSceneObjects", () => {
  it("keeps valid objects and resequences order to 1..N", () => {
    const out = normalizeSceneObjects(
      [
        { id: "title", type: "text", bbox: [100, 50, 900, 120], order: 1 },
        { id: "lion", type: "image", bbox: [80, 180, 420, 520], order: 7 },
      ],
      W,
      H,
    );
    expect(out.map((o) => o.id)).toEqual(["title", "lion"]);
    expect(out.map((o) => o.order)).toEqual([1, 2]);
  });

  it("clamps bbox to the canvas", () => {
    const [obj] = normalizeSceneObjects(
      [{ id: "overflow", type: "image", bbox: [-50, -50, 1500, 800], order: 1 }],
      W,
      H,
    );
    expect(obj.bbox).toEqual([0, 0, W, H]);
  });

  it("fixes inverted corners", () => {
    const [obj] = normalizeSceneObjects(
      [{ id: "flipped", type: "text", bbox: [800, 400, 100, 50], order: 1 }],
      W,
      H,
    );
    expect(obj.bbox).toEqual([100, 50, 800, 400]);
  });

  it("drops boxes with no drawable area", () => {
    const out = normalizeSceneObjects(
      [{ id: "tiny", type: "image", bbox: [100, 100, 102, 101], order: 1 }],
      W,
      H,
    );
    expect(out).toHaveLength(0);
  });

  it("drops entries without a usable bbox", () => {
    const out = normalizeSceneObjects(
      [
        { id: "no_bbox", type: "text", order: 1 },
        { id: "short_bbox", type: "text", bbox: [1, 2], order: 2 },
        { id: "nan_bbox", type: "text", bbox: ["a", "b", "c", "d"], order: 3 },
      ],
      W,
      H,
    );
    expect(out).toHaveLength(0);
  });

  it("de-duplicates ids", () => {
    const out = normalizeSceneObjects(
      [
        { id: "item", type: "text", bbox: [10, 10, 200, 60], order: 1 },
        { id: "item", type: "image", bbox: [10, 100, 200, 300], order: 2 },
      ],
      W,
      H,
    );
    expect(new Set(out.map((o) => o.id)).size).toBe(2);
  });

  it("generates an id when the payload omits one", () => {
    const [obj] = normalizeSceneObjects([{ type: "text", bbox: [10, 10, 200, 60] }], W, H);
    expect(obj.id).toBe("object_1");
  });

  it("falls back to type 'other' for unknown types", () => {
    const [obj] = normalizeSceneObjects(
      [{ id: "x", type: "diagram", bbox: [10, 10, 200, 200], order: 1 }],
      W,
      H,
    );
    expect(obj.type).toBe("other");
  });

  it("sorts by reviewer-supplied order", () => {
    const out = normalizeSceneObjects(
      [
        { id: "c", type: "text", bbox: [10, 300, 200, 350], order: 3 },
        { id: "a", type: "text", bbox: [10, 10, 200, 60], order: 1 },
        { id: "b", type: "text", bbox: [10, 150, 200, 200], order: 2 },
      ],
      W,
      H,
    );
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("breaks order ties by position (top-left first)", () => {
    const out = normalizeSceneObjects(
      [
        { id: "lower", type: "text", bbox: [10, 300, 200, 350], order: 1 },
        { id: "upper", type: "text", bbox: [10, 10, 200, 60], order: 1 },
      ],
      W,
      H,
    );
    expect(out.map((o) => o.id)).toEqual(["upper", "lower"]);
  });

  it("uses array position when order is missing", () => {
    const out = normalizeSceneObjects(
      [
        { id: "first", type: "text", bbox: [10, 400, 200, 450] },
        { id: "second", type: "text", bbox: [10, 10, 200, 60] },
      ],
      W,
      H,
    );
    expect(out.map((o) => o.id)).toEqual(["first", "second"]);
  });

  it("returns an empty list for non-array input", () => {
    expect(normalizeSceneObjects(null, W, H)).toEqual([]);
    expect(normalizeSceneObjects({ objects: [] }, W, H)).toEqual([]);
  });
});

describe("readSceneObjects", () => {
  it("returns the object list when the scene holds one", () => {
    expect(readSceneObjects({ objects: [{ id: "a" }] })).toHaveLength(1);
  });

  it("returns null for an un-analyzed scene", () => {
    expect(readSceneObjects(null)).toBeNull();
    expect(readSceneObjects({})).toBeNull();
    expect(readSceneObjects({ objects: [] })).toBeNull();
  });
});
