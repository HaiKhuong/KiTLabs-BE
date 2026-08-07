import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { join } from "path";

import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import type { WhiteboardHistory } from "./whiteboard-history.entity";
import { WHITEBOARD_QUEUE_NAME, WhiteboardService } from "./whiteboard.service";
import { buildWhiteboardCameraPlan } from "./whiteboard-camera";
import { WhiteboardMergeService } from "./whiteboard-merge.service";
import { WhiteboardPathPlanner } from "./whiteboard-path-planner";
import { WhiteboardRendererService } from "./whiteboard-renderer.service";
import {
  WhiteboardVoiceService,
  type WhiteboardEngineStoryboard,
  type WhiteboardVoiceConfig,
} from "./whiteboard-voice.service";
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
    private readonly rendererService: WhiteboardRendererService,
    private readonly voiceService: WhiteboardVoiceService,
    private readonly mergeService: WhiteboardMergeService,
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

      if (this.whiteboardService.isMergeJob(history)) {
        await this.processMergeJob(id, history, userId, nodeId);
        return;
      }

      const sourceImagePath = this.whiteboardService.resolveSourceImagePath(history);
      const reviewed = readSceneObjects(history.sceneJson);
      if (!reviewed) {
        throw new UnrecoverableError("No reviewed boxes — draw boxes before rendering");
      }

      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 1/3] Preparing scene…");
      this.logger.log(`[${id}] Using reviewed scene (${reviewed.length} objects)`);
      let scene: WhiteboardSceneJson = {
        imageWidth: history.imageWidth ?? 0,
        imageHeight: history.imageHeight ?? 0,
        objects: reviewed as WhiteboardObject[],
      };

      const workDir = this.whiteboardService.prepareWorkDir(id);
      const engineConfig = { ...(history.engineConfig ?? {}) } as Record<string, unknown>;
      const voiceConfig = (engineConfig.voice ?? null) as WhiteboardVoiceConfig | null;
      const storyboards = (engineConfig.storyboards ?? null) as WhiteboardEngineStoryboard[] | null;

      const useCustomHand = engineConfig.useCustomHand !== false;
      if (useCustomHand) {
        const handPath = this.whiteboardService.resolveHandImagePath(userId);
        if (handPath) {
          engineConfig.handImagePath = handPath;
        }
      } else {
        delete engineConfig.handImagePath;
      }

      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 2/3] Generating storyboard voices…");
      const prepared = await this.voiceService.prepareStoryboardVoices({
        userId,
        scene,
        workDir,
        voice: voiceConfig,
        storyboards,
      });
      scene = prepared.scene;
      if (prepared.voiceAssets.length > 0) {
        engineConfig.voiceAssets = prepared.voiceAssets.map((asset) => ({
          index: asset.index,
          path: asset.path,
          durationSec: asset.durationSec,
        }));
        engineConfig.voiceSchedule = prepared.voiceSchedule.map((entry) => ({
          index: entry.index,
          startSec: entry.startSec,
          durationSec: entry.durationSec,
          path: entry.path,
        }));
        await this.whiteboardService.updateSceneAndEngineConfig(id, scene, engineConfig);
        this.logger.log(`[${id}] Prepared ${prepared.voiceAssets.length} storyboard voice(s)`);
      }

      await this.whiteboardService.updateRuntimeMessage(id, "[STEP 3/3] Planning hand path + rendering…");
      let pathPlan = WhiteboardPathPlanner.plan(
        scene,
        scene.imageWidth,
        scene.imageHeight,
        engineConfig,
      );
      if (prepared.voiceSchedule.length > 0) {
        pathPlan = WhiteboardPathPlanner.alignToVoiceSchedule(
          pathPlan,
          scene,
          prepared.voiceSchedule,
        );
      }

      const cameraZooms = Array.isArray(engineConfig.cameraZooms)
        ? (engineConfig.cameraZooms as Array<{ storyboardIndices: number[] }>)
        : null;
      const cameraPlan = buildWhiteboardCameraPlan({
        scene,
        pathPlan,
        voiceSchedule: prepared.voiceSchedule,
        cameraZooms,
        imageWidth: scene.imageWidth,
        imageHeight: scene.imageHeight,
      });
      if (cameraPlan) {
        engineConfig.cameraPlan = cameraPlan;
        await this.whiteboardService.updateSceneAndEngineConfig(id, scene, engineConfig);
      }

      await this.whiteboardService.updatePathPlan(id, pathPlan as unknown as Record<string, unknown>);

      this.logger.log(`[${id}] Starting Remotion render`);
      const resultPath = await this.rendererService.render({
        historyId: id,
        sourceImagePath,
        imageWidth: scene.imageWidth,
        imageHeight: scene.imageHeight,
        sceneJson: scene,
        pathPlan,
        engineConfig,
        workDir,
        voiceAssets: prepared.voiceAssets,
        voiceSchedule: prepared.voiceSchedule,
        cameraPlan,
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

  private async processMergeJob(
    id: string,
    _history: WhiteboardHistory,
    userId: string,
    nodeId: string,
  ): Promise<void> {
    await this.whiteboardService.updateRuntimeMessage(id, "[MERGE] Ghép video bằng FFmpeg…");
    const { sourceHistoryIds, transitions, summary } =
      this.whiteboardService.getMergeJobConfig(_history);
    const inputPaths: string[] = [];
    for (const sourceId of sourceHistoryIds) {
      const source = await this.whiteboardService.getById(sourceId);
      if (!source?.resultPath) {
        throw new UnrecoverableError(`Thiếu output nguồn: ${sourceId}`);
      }
      inputPaths.push(this.whiteboardService.resolveArtifactPath(source));
    }

    const workDir = this.whiteboardService.prepareWorkDir(id);
    const mergeTransitions = [...transitions];

    if (summary?.enabled && summary.imagePath) {
      const summaryVideoPath = join(workDir, "summary.mp4");
      await this.mergeService.stillImageToVideo({
        imagePath: summary.imagePath,
        outputPath: summaryVideoPath,
        durationSec: summary.durationSec,
        width: _history.imageWidth ?? 1920,
        height: _history.imageHeight ?? 1080,
      });
      inputPaths.push(summaryVideoPath);
      mergeTransitions.push(summary.transition);
      this.logger.log(`[${id}] Appended summary outro (${summary.durationSec}s)`);
    }

    this.logger.log(`[${id}] Merging ${inputPaths.length} clips`);
    const resultPath = await this.mergeService.mergeWithSlides({
      workDir,
      inputPaths,
      transitions: mergeTransitions,
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
        kind: "merge",
      },
    });
  }
}
