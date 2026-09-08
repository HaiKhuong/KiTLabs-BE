export const NARRATO_STEP_IDS = ["ingest", "plot", "copy", "match", "mix", "render"] as const;

export type NarratoStepId = (typeof NARRATO_STEP_IDS)[number];

export const NARRATO_STEP_SCRIPTS: Record<NarratoStepId, string> = {
  ingest: "step_ingest.py",
  plot: "step_plot.py",
  copy: "step_copy.py",
  match: "step_match.py",
  mix: "step_mix.py",
  render: "step_render.py",
};

export const NARRATO_STEP_LABELS: Record<NarratoStepId, string> = {
  ingest: "1. Ingest",
  plot: "2. Plot",
  copy: "3. Copy",
  match: "4. Match",
  mix: "5. Mix-cut",
  render: "6. Render",
};

export type NarratoStepProgress = {
  completedSteps: NarratoStepId[];
  runningStep: NarratoStepId | null;
  failedStep: NarratoStepId | null;
};

export function emptyNarratoStepProgress(): NarratoStepProgress {
  return { completedSteps: [], runningStep: null, failedStep: null };
}

export function readNarratoStepProgress(engineConfig: Record<string, unknown> | null): NarratoStepProgress {
  const raw = engineConfig?.narratoStepProgress as Partial<NarratoStepProgress> | undefined;
  const completed = Array.isArray(raw?.completedSteps)
    ? raw!.completedSteps.filter((s): s is NarratoStepId => NARRATO_STEP_IDS.includes(s as NarratoStepId))
    : [];
  const running =
    raw?.runningStep && NARRATO_STEP_IDS.includes(raw.runningStep as NarratoStepId)
      ? (raw.runningStep as NarratoStepId)
      : null;
  const failed =
    raw?.failedStep && NARRATO_STEP_IDS.includes(raw.failedStep as NarratoStepId)
      ? (raw.failedStep as NarratoStepId)
      : null;
  return { completedSteps: completed, runningStep: running, failedStep: failed };
}

export function isNarratoStepId(value: string): value is NarratoStepId {
  return (NARRATO_STEP_IDS as readonly string[]).includes(value);
}
