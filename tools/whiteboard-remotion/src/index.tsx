import React from "react";
import { Composition, registerRoot } from "remotion";
import { WhiteboardComposition } from "./WhiteboardComposition";
import type { WhiteboardCompositionProps } from "./WhiteboardComposition";

const FALLBACK_FPS = 30;
const FALLBACK_WIDTH = 1280;
const FALLBACK_HEIGHT = 720;
const FALLBACK_DURATION_SEC = 10;

/** h264 rejects odd frame dimensions, so every side is rounded up to an even number. */
const toEvenSize = (value: number | undefined, fallback: number): number => {
  const n = Math.round(Number(value));
  const safe = Number.isFinite(n) && n > 0 ? n : fallback;
  return safe % 2 === 0 ? safe : safe + 1;
};

const defaultProps: WhiteboardCompositionProps = {
  sourceImageDataUrl: "",
  imageWidth: FALLBACK_WIDTH,
  imageHeight: FALLBACK_HEIGHT,
  pathPlan: {
    totalDurationSec: FALLBACK_DURATION_SEC,
    fps: FALLBACK_FPS,
    brushSize: 60,
    brushSpeedPx: 600,
    objectPaths: [],
  },
  audioCues: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WhiteboardReveal"
      component={WhiteboardComposition}
      durationInFrames={FALLBACK_DURATION_SEC * FALLBACK_FPS}
      fps={FALLBACK_FPS}
      width={FALLBACK_WIDTH}
      height={FALLBACK_HEIGHT}
      defaultProps={defaultProps}
      calculateMetadata={({ props }) => {
        const fps = Number(props.pathPlan?.fps) || FALLBACK_FPS;
        const visualSec = Number(props.pathPlan?.totalDurationSec) || FALLBACK_DURATION_SEC;
        const audioEndSec = (props.audioCues ?? []).reduce((max, cue) => {
          const startSec = Number(cue.startFrame) / fps;
          const durationSec = Number(cue.durationSec) || 0;
          return Math.max(max, startSec + durationSec);
        }, 0);
        const totalDurationSec = Math.max(visualSec, audioEndSec, FALLBACK_DURATION_SEC);
        const width = toEvenSize(props.imageWidth, FALLBACK_WIDTH);
        const height = toEvenSize(props.imageHeight, FALLBACK_HEIGHT);

        return {
          fps,
          durationInFrames: Math.max(1, Math.ceil(totalDurationSec * fps)),
          width,
          height,
          props: { ...props, imageWidth: width, imageHeight: height },
        };
      }}
    />
  );
};

registerRoot(RemotionRoot);
