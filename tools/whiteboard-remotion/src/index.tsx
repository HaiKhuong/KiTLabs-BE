import React from "react";
import { Composition, getInputProps } from "remotion";
import { WhiteboardComposition } from "./WhiteboardComposition";
import type { WhiteboardCompositionProps } from "./WhiteboardComposition";

const inputProps = getInputProps() as WhiteboardCompositionProps & {
  durationInFrames?: number;
  fps?: number;
};

const fps = inputProps.fps ?? 30;
const totalDurationSec = inputProps.pathPlan?.totalDurationSec ?? 10;
const durationInFrames = Math.max(1, Math.ceil(totalDurationSec * fps));
const imageWidth = inputProps.imageWidth ?? 1280;
const imageHeight = inputProps.imageHeight ?? 720;

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="WhiteboardReveal"
      component={WhiteboardComposition}
      durationInFrames={durationInFrames}
      fps={fps}
      width={imageWidth}
      height={imageHeight}
      defaultProps={inputProps}
    />
  );
};
