import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { WHITEBOARD_QUEUE_NAME, WhiteboardService } from "./whiteboard.service";
import { WhiteboardVisionService } from "./whiteboard-vision.service";
import { WhiteboardPathPlanner } from "./whiteboard-path-planner";
import { WhiteboardRendererService } from "./whiteboard-renderer.service";
import { readSceneObjects, WhiteboardObject, WhiteboardSceneJson } from "./whiteboard-scene";

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

      const sourceImagePath = this.whiteboardService.resolveSourceImagePath(history);

      // The review flow stores an approved scene, so vision only runs as a fallback
      // for jobs queued without a review pass.
      const reviewed = readSceneObjects(history.sceneJson);
      let scene: WhiteboardSceneJson;
      if (reviewed) {
        await this.whiteboardService.updateRuntimeMessage(id, "[STEP 1/2] Using reviewed scene…");
        this.logger.log(`[${id}] Reusing reviewed scene (${reviewed.length} objects)`);
        scene = {
          imageWidth: history.imageWidth ?? 0,
          imageHeight: history.imageHeight ?? 0,
          objects: reviewed as WhiteboardObject[],
        };
      } else {
        await this.whiteboardService.updateRuntimeMessage(id, "[STEP 1/2] Vision analysis with Gemini…");
        this.logger.log(`[${id}] Running vision analysis on ${sourceImagePath}`);
        scene = (await this.visionService.analyze(sourceImagePath)).sceneJson;
        await this.whiteboardService.saveAnalyzedScene(id, scene);
      }

      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 2/2] Planning hand path + rendering…");
      const engineConfig = (history.engineConfig ?? {}) as Record<string, unknown>;
      const pathPlan = WhiteboardPathPlanner.plan(
        scene,
        scene.imageWidth,
        scene.imageHeight,
        engineConfig,
      );
      await this.whiteboardService.updatePathPlan(id, pathPlan as unknown as Record<string, unknown>);

      this.logger.log(`[${id}] Starting Remotion render`);
      const workDir = this.whiteboardService.prepareWorkDir(id);
      const resultPath = await this.rendererService.render({
        historyId: id,
        sourceImagePath,
        imageWidth: scene.imageWidth,
        imageHeight: scene.imageHeight,
        sceneJson: scene,
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
