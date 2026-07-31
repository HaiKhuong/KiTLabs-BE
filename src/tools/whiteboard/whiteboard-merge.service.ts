import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

export const MERGE_SLIDE_TRANSITIONS = [
  "slide_left",
  "slide_right",
  "slide_up",
  "slide_down",
] as const;

export type MergeSlideTransition = (typeof MERGE_SLIDE_TRANSITIONS)[number];

const XFADE_MAP: Record<MergeSlideTransition, string> = {
  slide_left: "slideleft",
  slide_right: "slideright",
  slide_up: "slideup",
  slide_down: "slidedown",
};

const DEFAULT_TRANSITION_SEC = 0.5;

@Injectable()
export class WhiteboardMergeService {
  private readonly logger = new Logger(WhiteboardMergeService.name);

  isMergeSlideTransition(value: unknown): value is MergeSlideTransition {
    return (
      typeof value === "string" &&
      (MERGE_SLIDE_TRANSITIONS as readonly string[]).includes(value)
    );
  }

  async probeDurationSec(filePath: string): Promise<number> {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ];
    const { stdout } = await this.runCommand("ffprobe", args);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new BadRequestException(`Không đọc được duration: ${filePath}`);
    }
    return duration;
  }

  async probeHasAudio(filePath: string): Promise<boolean> {
    const args = [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      filePath,
    ];
    try {
      const { stdout } = await this.runCommand("ffprobe", args);
      return stdout.trim().toLowerCase().includes("audio");
    } catch {
      return false;
    }
  }

  /**
   * Concatenate clips with xfade slide transitions (+ acrossfade when audio exists).
   * Returns absolute path to merged.mp4.
   */
  async mergeWithSlides(opts: {
    workDir: string;
    inputPaths: string[];
    transitions: MergeSlideTransition[];
    transitionSec?: number;
  }): Promise<string> {
    const inputs = opts.inputPaths;
    if (inputs.length < 2) {
      throw new BadRequestException("Cần ít nhất 2 video để gộp");
    }
    if (opts.transitions.length !== inputs.length - 1) {
      throw new BadRequestException("Số transition phải bằng số mối nối (N-1)");
    }
    for (const path of inputs) {
      if (!existsSync(path)) throw new BadRequestException(`Thiếu file video: ${path}`);
    }

    mkdirSync(opts.workDir, { recursive: true });
    mkdirSync(join(opts.workDir, "output"), { recursive: true });
    const outputPath = join(opts.workDir, "output", "merged.mp4");

    const durations = await Promise.all(inputs.map((path) => this.probeDurationSec(path)));
    const hasAudioFlags = await Promise.all(inputs.map((path) => this.probeHasAudio(path)));
    const useAudio = hasAudioFlags.every(Boolean);

    let transitionSec = Math.max(0.05, Number(opts.transitionSec) || DEFAULT_TRANSITION_SEC);
    for (let i = 0; i < inputs.length; i += 1) {
      const maxT = Math.max(0.05, durations[i] * 0.45);
      transitionSec = Math.min(transitionSec, maxT);
    }

    const filterParts: string[] = [];
    let lastV = "0:v";
    let lastA = "0:a";
    let cumulative = durations[0];

    for (let i = 0; i < opts.transitions.length; i += 1) {
      const nextIndex = i + 1;
      const xfade = XFADE_MAP[opts.transitions[i]] ?? "slideleft";
      const offset = Math.max(0, cumulative - transitionSec);
      const outV = i === opts.transitions.length - 1 ? "vout" : `v${i}`;
      const outA = i === opts.transitions.length - 1 ? "aout" : `a${i}`;

      filterParts.push(
        `[${lastV}][${nextIndex}:v]xfade=transition=${xfade}:duration=${transitionSec}:offset=${offset}[${outV}]`,
      );
      if (useAudio) {
        filterParts.push(
          `[${lastA}][${nextIndex}:a]acrossfade=d=${transitionSec}:c1=tri:c2=tri[${outA}]`,
        );
      }

      lastV = outV;
      lastA = outA;
      cumulative += durations[nextIndex] - transitionSec;
    }

    const args: string[] = ["-y"];
    for (const path of inputs) {
      args.push("-i", path);
    }
    args.push("-filter_complex", filterParts.join(";"));
    args.push("-map", "[vout]");
    if (useAudio) {
      args.push("-map", "[aout]");
    } else {
      args.push("-an");
    }
    args.push(
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "18",
    );
    if (useAudio) {
      args.push("-c:a", "aac", "-b:a", "192k");
    }
    args.push("-movflags", "+faststart", outputPath);

    this.logger.log(
      `Merging ${inputs.length} clips (T=${transitionSec}s, audio=${useAudio}) → ${outputPath}`,
    );
    await this.runCommand("ffmpeg", args, Number(process.env.WHITEBOARD_CMD_TIMEOUT_MS ?? 1_800_000));
    if (!existsSync(outputPath)) {
      throw new BadRequestException("FFmpeg merge không tạo được output");
    }
    return outputPath;
  }

  private runCommand(
    bin: string,
    args: string[],
    timeoutMs = 120_000,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, args, { windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${bin} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(stderr.trim() || `${bin} exited ${code}`));
      });
    });
  }
}
