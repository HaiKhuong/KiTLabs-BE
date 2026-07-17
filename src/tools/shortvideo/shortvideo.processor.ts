import { Logger } from "@nestjs/common";
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job, UnrecoverableError } from "bullmq";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";

import { AudioService } from "../audio/audio.service";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { SHORTVIDEO_QUEUE_NAME, ShortVideoService } from "./shortvideo.service";
import { ShortVideoHistory } from "./shortvideo-history.entity";

const MAX_LOG_BUFFER = 4 * 1024 * 1024;

@Processor(SHORTVIDEO_QUEUE_NAME, {
  concurrency: 1,
  lockDuration: ShortVideoService.resolveQueueLockDurationMs(),
  stalledInterval: 120_000,
  maxStalledCount: 2,
})
export class ShortVideoProcessor extends WorkerHost {
  private readonly logger = new Logger(ShortVideoProcessor.name);

  constructor(
    private readonly shortVideoService: ShortVideoService,
    private readonly realtimeGateway: ToolsRealtimeGateway,
    private readonly audioService: AudioService,
  ) {
    super();
  }

  private resolvePythonBin(): string {
    return (
      process.env.SHORTVIDEO_PYTHON_BIN ??
      process.env.TRANSLATE_PYTHON_BIN ??
      (process.platform === "win32" ? "py" : "python3")
    );
  }

  private resolveTimeoutMs(): number {
    return Number(process.env.SHORTVIDEO_CMD_TIMEOUT_MS ?? 1_800_000);
  }

  async process(job: Job<{ shortVideoHistoryId: string }>): Promise<void> {
    const id = job.data?.shortVideoHistoryId;
    if (!id) throw new UnrecoverableError("shortVideoHistoryId is required");

    const history = await this.shortVideoService.getById(id);
    if (!history) throw new UnrecoverableError(`ShortVideo history not found: ${id}`);

    const userId = history.userId;
    const nodeId = history.nodeId ?? "";

    try {
      await this.shortVideoService.processStarted(id);

      const workDir = this.shortVideoService.prepareWorkDir(id);
      await this.maybeGenerateVoice(history, workDir);
      const configPath = this.shortVideoService.writeJobConfig(workDir, history);
      const scriptPath = this.shortVideoService.resolveScriptPath();
      if (!existsSync(scriptPath)) {
        throw new UnrecoverableError(`ShortVideo python script not found: ${scriptPath}`);
      }

      const resultPath = await this.spawnPipeline({ id, scriptPath, workDir, configPath });

      await this.shortVideoService.processCompleted(id, resultPath);
      const completed = await this.shortVideoService.getById(id);
      const mapped = completed ? this.shortVideoService.mapForClient(completed) : null;

      this.realtimeGateway.notifyUser(userId, "workflow.job.completed", {
        jobId: id,
        nodeId,
        type: "short_video",
        result: {
          shortVideoHistoryId: id,
          resultPath,
          resultFileName: mapped?.resultFileName ?? null,
          playUrl: mapped?.playUrl ?? null,
          downloadUrl: mapped?.downloadUrl ?? null,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.shortVideoService.processFailed(id, message);
      this.realtimeGateway.notifyUser(userId, "workflow.job.failed", {
        jobId: id,
        nodeId,
        type: "short_video",
        errorMessage: message,
        terminal: true,
      });
      throw error;
    }
  }

  /** When spec.voiceConfig.generate is true, synthesize a voice track from the captions. */
  private async maybeGenerateVoice(history: ShortVideoHistory, workDir: string): Promise<void> {
    const spec = (history.spec ?? {}) as Record<string, unknown>;
    const vc = spec.voiceConfig as Record<string, unknown> | undefined;
    if (!vc || vc.generate !== true) return;

    const voiceScenes = ShortVideoService.buildSceneVoiceTexts(spec);
    if (voiceScenes.length === 0) {
      throw new UnrecoverableError("Không có caption/subtitle để tạo voice");
    }
    // One joined sentence per scene so TTS reads each scene without pauses.
    const captionList = voiceScenes.map((v) => v.text);

    const outWav = join(workDir, "tts_voice.wav");
    const refOpts = {
      userId: history.userId,
      ttsEngine: typeof vc.engine === "string" ? vc.engine : undefined,
      voiceMode: (String(vc.mode ?? "preset") === "clone" ? "clone" : "preset") as
        | "preset"
        | "clone",
      voiceId: typeof vc.voiceId === "string" ? vc.voiceId : undefined,
      pipelineRefWav: typeof vc.pipelineRefWav === "string" ? vc.pipelineRefWav : undefined,
      cloneRefText: typeof vc.refText === "string" ? vc.refText : undefined,
      language: typeof vc.language === "string" ? vc.language : undefined,
      speed: typeof vc.speed === "number" ? vc.speed : undefined,
    };

    // Timing is always driven by the generated voice: scene durations come from
    // the measured audio and captions are distributed across it. The `duration`
    // and caption `time` fields in the spec are ignored.
    await this.shortVideoService.updateRuntimeMessage(
      history.id,
      "[STEP 0/6] Generate voice + sync timeline (TTS)",
    );
    const result = await this.audioService.generateVoiceTimeline({
      ...refOpts,
      captions: captionList,
      outWav,
      gapSec: typeof vc.gapSec === "number" ? vc.gapSec : undefined,
    });
    this.applySyncedTimeline(
      spec,
      voiceScenes,
      result,
      typeof vc.gapSec === "number" ? vc.gapSec : 0.12,
    );

    spec.voice = outWav.replaceAll("\\", "/");
    history.spec = spec;
    await this.shortVideoService.persistSpec(history.id, spec);
  }

  /**
   * Rebuild the whole timeline from the generated audio. Each scene produced one
   * voice segment (its captions joined), so every scene's duration is the
   * measured speech length and scenes are laid out contiguously. The scene's
   * captions are then spread across that duration weighted by text length — the
   * spec's `duration` and caption `time` fields are ignored entirely.
   */
  private applySyncedTimeline(
    spec: Record<string, unknown>,
    voiceScenes: { sceneIndex: number; text: string }[],
    result: { totalSec: number; segments: { start: number; end: number }[] },
    gapSec: number,
  ): void {
    const segments = result.segments ?? [];
    if (segments.length === 0) return;

    const round3 = (n: number) => Math.round(n * 1000) / 1000;
    const scenes = Array.isArray(spec.scenes) ? (spec.scenes as Record<string, unknown>[]) : [];

    // Map each measured segment back to the scene it was generated from.
    const segByScene = new Map<number, { start: number; end: number }>();
    voiceScenes.forEach((vs, i) => {
      if (segments[i]) segByScene.set(vs.sceneIndex, segments[i]);
    });
    const lastVoiceIndex = voiceScenes.reduce((max, vs) => Math.max(max, vs.sceneIndex), -1);

    // Lay scenes out back-to-back using the measured speech duration of each.
    let cursor = 0;
    const newBounds = scenes.map((_s, i) => {
      const seg = segByScene.get(i);
      const speech = seg ? Math.max(0, seg.end - seg.start) : 0;
      const start = round3(cursor);
      // Match the silence the TTS inserts between consecutive scene segments.
      const tail = seg && i < lastVoiceIndex ? gapSec : 0;
      const end = round3(start + speech + tail);
      cursor = end;
      return { start, end, speech };
    });

    // Spread each scene's captions across its voice duration by text length.
    const perSceneCaptions = scenes.map((s, i) => {
      const caps = Array.isArray((s as Record<string, unknown>)?.captions)
        ? ((s as Record<string, unknown>).captions as Record<string, unknown>[])
        : [];
      const texts = caps.map((c) => String(c?.text ?? "").trim()).filter(Boolean);
      if (texts.length === 0) return [] as { time: number; text: string }[];

      const nb = newBounds[i];
      const weights = texts.map((t) => Math.max(1, t.length));
      const totalWeight = weights.reduce((sum, w) => sum + w, 0);
      let acc = 0;
      return texts.map((text, k) => {
        const frac = totalWeight > 0 ? acc / totalWeight : 0;
        acc += weights[k];
        return { time: round3(nb.start + frac * nb.speech), text };
      });
    });

    const flat = perSceneCaptions.flat();
    if (flat.length > 0) {
      flat.sort((a, b) => a.time - b.time);
      spec.captions = flat;
    } else {
      // Legacy top-level captions: anchor each caption to its segment start.
      spec.captions = segments.map((seg, i) => ({
        time: round3(seg.start),
        text: voiceScenes[i]?.text ?? "",
      }));
    }

    // Write the resolved timing back into scenes (and their nested captions) so
    // every consumer sees the voice-driven timeline as the source of truth.
    spec.scenes = scenes.map((s, i) => ({
      ...s,
      start: newBounds[i].start,
      end: newBounds[i].end,
      ...(perSceneCaptions[i].length > 0 ? { captions: perSceneCaptions[i] } : {}),
    }));
  }

  private spawnPipeline(input: {
    id: string;
    scriptPath: string;
    workDir: string;
    configPath: string;
  }): Promise<string> {
    const pythonBin = this.resolvePythonBin();
    const scriptDir = dirname(input.scriptPath);
    const timeoutMs = this.resolveTimeoutMs();
    const args = [
      input.scriptPath,
      "--config",
      input.configPath,
      "--work-dir",
      input.workDir,
    ];

    this.logger.log(`Spawning shortvideo pipeline: ${pythonBin} ${args.join(" ")}`);

    return new Promise<string>((resolvePromise, rejectPromise) => {
      let stdoutBuf = "";
      let stderrBuf = "";
      let settled = false;

      const child = spawn(pythonBin, args, {
        cwd: scriptDir,
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          PYTHONIOENCODING: "utf-8",
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGTERM");
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 8_000).unref();
        settleReject(new Error(`ShortVideo pipeline timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const append = (target: "out" | "err", chunk: Buffer | string) => {
        const text = chunk.toString();
        if (target === "out") {
          stdoutBuf = (stdoutBuf + text).slice(-MAX_LOG_BUFFER);
        } else {
          stderrBuf = (stderrBuf + text).slice(-MAX_LOG_BUFFER);
        }
        const lines = text
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const stepLine = [...lines].reverse().find((l) => l.includes("[STEP "));
        const line = stepLine || lines[lines.length - 1];
        if (line) {
          void this.shortVideoService.updateRuntimeMessage(input.id, line.slice(0, 500));
        }
      };

      child.stdout?.on("data", (c) => append("out", c));
      child.stderr?.on("data", (c) => append("err", c));

      const settleReject = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      };

      const settleResolve = (path: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise(path);
      };

      child.on("error", (err) => settleReject(err));
      child.on("close", (code) => {
        const combined = `${stdoutBuf}\n${stderrBuf}`;
        const doneMatch = combined.match(/DONE:\s*(.+)/);
        if (code === 0 && doneMatch?.[1]) {
          const outPath = doneMatch[1].trim();
          if (existsSync(outPath)) {
            settleResolve(outPath);
            return;
          }
        }
        const fallback = join(input.workDir, "output", "short_video.mp4");
        if (code === 0 && existsSync(fallback)) {
          settleResolve(fallback);
          return;
        }
        const failMatch = combined.match(/\[SHORTVIDEO_FAILED]\s*(.+)/);
        settleReject(
          new Error(
            failMatch?.[1]?.trim() ||
              `ShortVideo pipeline exited with code ${code}. Tail: ${combined.slice(-2000)}`,
          ),
        );
      });
    });
  }
}
