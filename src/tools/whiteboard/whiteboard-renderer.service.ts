import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import type { WhiteboardSceneJson } from "./whiteboard-scene";
import type { WhiteboardPathPlan } from "./whiteboard-path-planner";
import type { WhiteboardVoiceAsset, WhiteboardVoiceScheduleEntry } from "./whiteboard-voice.service";

export type WhiteboardAudioCue = {
  srcDataUrl: string;
  startFrame: number;
  durationSec: number;
};

export interface WhiteboardRenderInput {
  historyId: string;
  sourceImagePath: string;
  imageWidth: number;
  imageHeight: number;
  sceneJson: WhiteboardSceneJson;
  pathPlan: WhiteboardPathPlan;
  engineConfig: Record<string, unknown>;
  workDir: string;
  voiceAssets?: WhiteboardVoiceAsset[];
  voiceSchedule?: WhiteboardVoiceScheduleEntry[];
}

@Injectable()
export class WhiteboardRendererService {
  private readonly logger = new Logger(WhiteboardRendererService.name);

  async render(input: WhiteboardRenderInput): Promise<string> {
    const { bundle, renderMedia, selectComposition } = await this.importRemotion();

    const compositionEntryPoint = resolve(
      process.cwd(),
      process.env.WHITEBOARD_REMOTION_ENTRY ?? "tools/whiteboard-remotion/src/index.tsx",
    );

    const publicDir = resolve(
      process.cwd(),
      process.env.WHITEBOARD_REMOTION_PUBLIC ?? "tools/whiteboard-remotion/public",
    );

    this.logger.log(`[${input.historyId}] Bundling Remotion composition…`);
    const bundleDir = await bundle({
      entryPoint: compositionEntryPoint,
      outDir: join(input.workDir, "bundle"),
      publicDir,
      onProgress: (progress: number) => {
        if (progress % 25 === 0) this.logger.log(`[${input.historyId}] Bundle progress: ${progress}%`);
      },
    });

    // Convert source image to a data URL so Remotion can load it as a static asset
    const imageBuffer = readFileSync(input.sourceImagePath);
    const ext = input.sourceImagePath.split(".").pop()?.toLowerCase() ?? "png";
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : "image/png";
    const sourceImageDataUrl = `data:${mimeType};base64,${imageBuffer.toString("base64")}`;

    const handImageDataUrl = this.resolveHandImageDataUrl(input);

    const fps = input.pathPlan.fps;
    const audioCues = this.buildAudioCues(input);
    const lastAudioEndSec = audioCues.reduce(
      (max, cue) => Math.max(max, cue.startFrame / fps + cue.durationSec),
      0,
    );
    const totalDurationSec = Math.max(input.pathPlan.totalDurationSec, lastAudioEndSec);
    const durationInFrames = Math.max(1, Math.ceil(totalDurationSec * fps));

    const inputProps = {
      sourceImageDataUrl,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      pathPlan: {
        ...input.pathPlan,
        totalDurationSec,
      },
      audioCues,
      handImageDataUrl,
    };

    const outputPath = join(input.workDir, "output", "whiteboard.mp4");

    this.logger.log(
      `[${input.historyId}] Rendering ${durationInFrames} frames at ${fps}fps` +
        (audioCues.length ? ` with ${audioCues.length} audio cue(s)` : ""),
    );

    const browserExecutable = this.resolveBrowserExecutable();
    if (browserExecutable) {
      this.logger.log(`[${input.historyId}] Using browser executable: ${browserExecutable}`);
    }

    const composition = await selectComposition({
      serveUrl: bundleDir,
      id: "WhiteboardReveal",
      inputProps,
      browserExecutable,
    });

    await renderMedia({
      composition,
      serveUrl: bundleDir,
      codec: "h264",
      outputLocation: outputPath,
      inputProps,
      browserExecutable,
      timeoutInMilliseconds: Number(process.env.WHITEBOARD_CMD_TIMEOUT_MS ?? 1_800_000),
      onProgress: ({ progress }: { progress: number }) => {
        const pct = Math.round(progress * 100);
        if (pct % 10 === 0) this.logger.log(`[${input.historyId}] Render progress: ${pct}%`);
      },
    });

    this.logger.log(`[${input.historyId}] Render complete: ${outputPath}`);
    return outputPath;
  }

  private resolveHandImageDataUrl(input: WhiteboardRenderInput): string | null {
    const configured = String(input.engineConfig.handImagePath ?? "").trim();
    const candidates = [configured].filter(Boolean);
    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        this.logger.warn(`[${input.historyId}] Missing hand image: ${candidate}`);
        continue;
      }
      try {
        const buf = readFileSync(candidate);
        const ext = candidate.split(".").pop()?.toLowerCase() ?? "png";
        const mime =
          ext === "svg"
            ? "image/svg+xml"
            : ext === "jpg" || ext === "jpeg"
              ? "image/jpeg"
              : ext === "webp"
                ? "image/webp"
                : "image/png";
        return `data:${mime};base64,${buf.toString("base64")}`;
      } catch (error) {
        this.logger.warn(`[${input.historyId}] Failed reading hand image: ${String(error)}`);
      }
    }
    return null;
  }

  private buildAudioCues(input: WhiteboardRenderInput): WhiteboardAudioCue[] {
    const schedule = input.voiceSchedule ?? [];
    const assets = input.voiceAssets ?? [];
    if (schedule.length === 0 && assets.length === 0) return [];

    const fps = Math.max(1, Number(input.pathPlan.fps) || 30);
    const cues: WhiteboardAudioCue[] = [];

    const entries =
      schedule.length > 0
        ? schedule
        : assets.map((asset) => ({
            index: asset.index,
            startSec: 0,
            durationSec: asset.durationSec,
            path: asset.path,
          }));

    for (const entry of entries) {
      if (!existsSync(entry.path)) {
        this.logger.warn(`[${input.historyId}] Missing voice asset: ${entry.path}`);
        continue;
      }
      const wav = readFileSync(entry.path);
      const srcDataUrl = `data:audio/wav;base64,${wav.toString("base64")}`;
      cues.push({
        srcDataUrl,
        startFrame: Math.max(0, Math.round(entry.startSec * fps)),
        durationSec: entry.durationSec,
      });
    }
    return cues;
  }

  /**
   * Without this, Remotion downloads its own Chrome Headless Shell into
   * node_modules/.remotion, which fails when the server user cannot write to
   * node_modules (deps installed by another user).
   */
  private resolveBrowserExecutable(): string | null {
    const configured = process.env.WHITEBOARD_BROWSER_EXECUTABLE?.trim();
    if (!configured) return null;
    if (!existsSync(configured)) {
      throw new Error(
        `WHITEBOARD_BROWSER_EXECUTABLE points to a missing file: ${configured}`,
      );
    }
    return configured;
  }

  private async importRemotion() {
    const { bundle } = await import("@remotion/bundler");
    const rendererModule = await import("@remotion/renderer");
    return { bundle, renderMedia: rendererModule.renderMedia, selectComposition: rendererModule.selectComposition };
  }
}
