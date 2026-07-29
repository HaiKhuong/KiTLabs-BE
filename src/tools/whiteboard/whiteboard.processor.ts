import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { existsSync } from "fs";
import { join } from "path";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { WHITEBOARD_QUEUE_NAME, WhiteboardService } from "./whiteboard.service";
import { WhiteboardVisionService } from "./whiteboard-vision.service";
import { WhiteboardPathPlanner } from "./whiteboard-path-planner";
import { WhiteboardRendererService } from "./whiteboard-renderer.service";

@Processor(WHITEBOARD_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: WhiteboardService.resolveQueueLockDurationMs(),
  stalledInterval: 120_000,
  maxStalledCount: 2,
})
export class WhiteboardProcessor extends WorkerHost {
  private readonly logger = new Logger(WhiteboardProcessor.name);

  constructor(
    private readonly whiteboardService: WhiteboardService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
    private readonly visionService: WhiteboardVisionService,
    private readonly rendererService: WhiteboardRendererService,
  ) {
    super();
  }

  async process(job: Job<{ whiteboardHistoryId: string }>): Promise<void> {
    const id = job.data?.whiteboardHistoryId;
    if (!id) throw new UnrecoverableError("whiteboardHistoryId is required");

    const history = await this.whiteboardService.getById(id);
    if (!history) throw new UnrecoverableError(`Whiteboard history not found: ${id}`);

    const userId = history.userId;
    const nodeId = history.nodeId ?? "";

    try {
      await this.whiteboardService.processStarted(id);

      // Resolve the uploaded source image path
      const sceneRaw = (history.sceneJson ?? {}) as Record<string, unknown>;
      const assetsDir = String(sceneRaw.assetsDir ?? "");
      const sourceFileName = history.sourceImageFileName ?? "source.png";
      const sourceImagePath = join(assetsDir, sourceFileName);

      if (!existsSync(sourceImagePath)) {
        throw new UnrecoverableError(`Source image not found: ${sourceImagePath}`);
      }

      // Step 1: Vision analysis
      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 1/3] Vision analysis with Gemini…");
      this.logger.log(`[${id}] Running vision analysis on ${sourceImagePath}`);
      const { sceneJson, imageWidth, imageHeight } = await this.visionService.analyze(sourceImagePath);
      await this.whiteboardService.updateImageDimensions(id, imageWidth, imageHeight);
      await this.whiteboardService.updateSceneJson(id, { ...sceneJson, assetsDir });

      // Step 2: Path planning
      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 2/3] Generating hand path plan…");
      this.logger.log(`[${id}] Planning hand path`);
      const engineConfig = (history.engineConfig ?? {}) as Record<string, unknown>;
      const pathPlan = WhiteboardPathPlanner.plan(sceneJson, imageWidth, imageHeight, engineConfig);
      await this.whiteboardService.updatePathPlan(id, pathPlan as unknown as Record<string, unknown>);

      // Step 3: Remotion render
      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 3/3] Rendering whiteboard video…");
      this.logger.log(`[${id}] Starting Remotion render`);
      const workDir = this.whiteboardService.prepareWorkDir(id);
      const resultPath = await this.rendererService.render({
        historyId: id,
        sourceImagePath,
        imageWidth,
        imageHeight,
        sceneJson,
        pathPlan,
        engineConfig,
        workDir,
      });

      await this.whiteboardService.processCompleted(id, resultPath);
      const completed = await this.whiteboardService.getById(id);
      const mapped = completed ? this.whiteboardService.mapForClient(completed) : null;

      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId: id,
        nodeId,
        type: "whiteboard",
        result: {
          whiteboardHistoryId: id,
          resultPath,
          resultFileName: mapped?.resultFileName ?? null,
          playUrl: mapped?.playUrl ?? null,
          downloadUrl: mapped?.downloadUrl ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.whiteboardService.processFailed(id, message);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId: id,
        nodeId,
        type: "whiteboard",
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }
}
