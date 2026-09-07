/** Recap pipeline steps — each maps to a dedicated Python script. */
export const RECAP_STEP_IDS = [
  "asr",
  "scenes",
  "cluster",
  "call_a1",
  "candidates",
  "call_a2",
  "tts",
  "call_b",
  "render",
] as const;

export type RecapStepId = (typeof RECAP_STEP_IDS)[number];

export const RECAP_STEP_SCRIPTS: Record<RecapStepId, string> = {
  asr: "step_01_asr.py",
  scenes: "step_02_scenes.py",
  cluster: "step_03_cluster.py",
  call_a1: "step_04_call_a1.py",
  candidates: "step_05_candidates.py",
  call_a2: "step_06_call_a2.py",
  tts: "step_07_tts.py",
  call_b: "step_08_call_b.py",
  render: "step_09_render.py",
};

export const RECAP_STEP_LABELS: Record<RecapStepId, string> = {
  asr: "1. ASR",
  scenes: "2. Scenes",
  cluster: "3. Cluster",
  call_a1: "4. Story (CallA-1)",
  candidates: "5. Candidates",
  call_a2: "6. Script (CallA-2)",
  tts: "7. TTS",
  call_b: "8. Shot Plan (CallB)",
  render: "9. Render",
};

export type RecapStepProgress = {
  completedSteps: RecapStepId[];
  runningStep: RecapStepId | null;
  failedStep: RecapStepId | null;
};

export function emptyRecapStepProgress(): RecapStepProgress {
  return { completedSteps: [], runningStep: null, failedStep: null };
}

export function readRecapStepProgress(engineConfig: Record<string, unknown> | null): RecapStepProgress {
  const raw = engineConfig?.recapStepProgress as Partial<RecapStepProgress> | undefined;
  const completed = Array.isArray(raw?.completedSteps)
    ? raw!.completedSteps.filter((s): s is RecapStepId => RECAP_STEP_IDS.includes(s as RecapStepId))
    : [];
  const running =
    raw?.runningStep && RECAP_STEP_IDS.includes(raw.runningStep as RecapStepId)
      ? (raw.runningStep as RecapStepId)
      : null;
  const failed =
    raw?.failedStep && RECAP_STEP_IDS.includes(raw.failedStep as RecapStepId)
      ? (raw.failedStep as RecapStepId)
      : null;
  return { completedSteps: completed, runningStep: running, failedStep: failed };
}

export function isRecapStepId(value: string): value is RecapStepId {
  return (RECAP_STEP_IDS as readonly string[]).includes(value);
}
