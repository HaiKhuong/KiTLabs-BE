import { Injectable, Logger } from "@nestjs/common";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { WhiteboardSceneJson } from "./whiteboard-scene";
import type { WhiteboardPathPlan } from "./whiteboard-path-planner";

export interface WhiteboardRenderInput {
  historyId: string;
  sourceImagePath: string;
  imageWidth: number;
  imageHeight: number;
  sceneJson: WhiteboardSceneJson;
  pathPlan: WhiteboardPathPlan;
  engineConfig: Record<string, unknown>;
  workDir: string;
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

    const fps = input.pathPlan.fps;
    const totalDurationSec = input.pathPlan.totalDurationSec;
    const durationInFrames = Math.max(1, Math.ceil(totalDurationSec * fps));

    const inputProps = {
      sourceImageDataUrl,
      imageWidth: input.imageWidth,
      imageHeight: input.imageHeight,
      pathPlan: input.pathPlan,
    };

    const outputPath = join(input.workDir, "output", "whiteboard.mp4");

    this.logger.log(`[${input.historyId}] Rendering ${durationInFrames} frames at ${fps}fps…`);

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
