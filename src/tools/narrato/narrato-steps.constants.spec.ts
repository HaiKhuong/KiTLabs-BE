import { isNarratoStepId } from "./narrato-steps.constants";

describe("isNarratoStepId", () => {
  it("accepts pipeline steps", () => {
    expect(isNarratoStepId("ingest")).toBe(true);
    expect(isNarratoStepId("plot")).toBe(true);
    expect(isNarratoStepId("copy")).toBe(true);
    expect(isNarratoStepId("match")).toBe(true);
    expect(isNarratoStepId("mix")).toBe(true);
    expect(isNarratoStepId("render")).toBe(true);
  });

  it("rejects recap and unknown steps", () => {
    expect(isNarratoStepId("asr")).toBe(false);
    expect(isNarratoStepId("call_a1")).toBe(false);
    expect(isNarratoStepId("")).toBe(false);
  });
});
