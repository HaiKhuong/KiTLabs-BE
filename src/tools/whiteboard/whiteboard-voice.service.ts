import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";

import { AudioService } from "../audio/audio.service";
import type { WhiteboardObject, WhiteboardSceneJson } from "./whiteboard-scene";

export type WhiteboardVoiceConfig = {
  voiceMode: "preset" | "clone";
  voiceId?: string;
  pipelineRefWav?: string;
  cloneRefText?: string;
  ttsEngine?: "omnivoice";
  speed?: number;
};

export type WhiteboardVoiceAsset = {
  index: number;
  path: string;
  durationSec: number;
  voice: string;
};

@Injectable()
export class WhiteboardVoiceService {
  private readonly logger = new Logger(WhiteboardVoiceService.name);

  constructor(private readonly audioService: AudioService) {}

  /**
   * Generate OmniVoice WAV per unique storyboard, measure duration, and split
   * durationSec evenly across objects that share the same storyboard index.
   */
  async prepareStoryboardVoices(opts: {
    userId: string;
    scene: WhiteboardSceneJson;
    workDir: string;
    voice?: WhiteboardVoiceConfig | null;
  }): Promise<{ scene: WhiteboardSceneJson; voiceAssets: WhiteboardVoiceAsset[] }> {
    const objects = opts.scene.objects ?? [];
    const storyboardObjects = objects.filter(
      (obj) => obj.storyboard && String(obj.storyboard.voice ?? "").trim(),
    );
    if (storyboardObjects.length === 0) {
      return { scene: opts.scene, voiceAssets: [] };
    }

    const voice = opts.voice;
    if (!voice?.voiceMode) {
      throw new BadRequestException(
        "engineConfig.voice is required when objects include storyboard voice",
      );
    }
    if (voice.voiceMode === "preset" && !voice.voiceId?.trim()) {
      throw new BadRequestException("engineConfig.voice.voiceId is required for preset mode");
    }
    if (voice.voiceMode === "clone" && !voice.pipelineRefWav?.trim()) {
      throw new BadRequestException(
        "engineConfig.voice.pipelineRefWav is required for clone mode",
      );
    }

    const unique = new Map<number, string>();
    for (const obj of storyboardObjects) {
      const index = Number(obj.storyboard!.index);
      const text = String(obj.storyboard!.voice).trim();
      if (!Number.isFinite(index) || !text) continue;
      if (!unique.has(index)) unique.set(index, text);
    }
    if (unique.size === 0) {
      return { scene: opts.scene, voiceAssets: [] };
    }

    const voicesDir = join(opts.workDir, "voices");
    mkdirSync(voicesDir, { recursive: true });

    const voiceAssets: WhiteboardVoiceAsset[] = [];
    for (const [index, text] of [...unique.entries()].sort((a, b) => a[0] - b[0])) {
      const outWav = join(voicesDir, `sb_${index}.wav`);
      this.logger.log(`Generating storyboard voice sb_${index} (${text.length} chars)`);
      await this.audioService.generateVoiceToFile({
        userId: opts.userId,
        text,
        outWav,
        ttsEngine: "omnivoice",
        voiceMode: voice.voiceMode,
        voiceId: voice.voiceId,
        pipelineRefWav: voice.pipelineRefWav,
        cloneRefText: voice.cloneRefText,
        speed: voice.speed,
      });
      const durationSec = await this.measureWavDurationSec(outWav);
      voiceAssets.push({
        index,
        path: outWav,
        durationSec,
        voice: text,
      });
    }

    const counts = new Map<number, number>();
    for (const obj of storyboardObjects) {
      const index = Number(obj.storyboard!.index);
      counts.set(index, (counts.get(index) ?? 0) + 1);
    }

    const durationByIndex = new Map(voiceAssets.map((asset) => [asset.index, asset.durationSec]));
    const nextObjects: WhiteboardObject[] = objects.map((obj) => {
      if (!obj.storyboard || !String(obj.storyboard.voice ?? "").trim()) return obj;
      const index = Number(obj.storyboard.index);
      const total = durationByIndex.get(index);
      const shareCount = counts.get(index) ?? 1;
      if (!(typeof total === "number") || !(total > 0) || shareCount < 1) return obj;
      const durationSec = Math.min(60, Math.max(0.1, total / shareCount));
      return { ...obj, durationSec };
    });

    return {
      scene: { ...opts.scene, objects: nextObjects },
      voiceAssets,
    };
  }

  /** Prefer ffprobe; fall back to WAV header parsing. */
  async measureWavDurationSec(filePath: string): Promise<number> {
    if (!existsSync(filePath)) {
      throw new BadRequestException(`Voice wav missing: ${filePath}`);
    }

    try {
      const probed = await this.ffprobeDurationSec(filePath);
      if (probed > 0) return probed;
    } catch (error) {
      this.logger.warn(`ffprobe failed for ${filePath}: ${String(error)}`);
    }

    const parsed = this.parseWavDurationSec(filePath);
    if (parsed > 0) return parsed;
    throw new BadRequestException(`Unable to measure voice duration: ${filePath}`);
  }

  private ffprobeDurationSec(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        "ffprobe",
        ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
        { windowsHide: true },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `ffprobe exited ${code}`));
          return;
        }
        const value = Number(stdout.trim());
        resolve(Number.isFinite(value) ? value : 0);
      });
    });
  }

  private parseWavDurationSec(filePath: string): number {
    const buffer = readFileSync(filePath);
    if (buffer.length < 44) return 0;
    if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
      return 0;
    }

    let offset = 12;
    let sampleRate = 0;
    let byteRate = 0;
    let dataSize = 0;
    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString("ascii", offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const dataOffset = offset + 8;
      if (chunkId === "fmt " && dataOffset + 16 <= buffer.length) {
        sampleRate = buffer.readUInt32LE(dataOffset + 4);
        byteRate = buffer.readUInt32LE(dataOffset + 8);
      } else if (chunkId === "data") {
        dataSize = chunkSize;
        break;
      }
      offset = dataOffset + chunkSize + (chunkSize % 2);
    }

    if (byteRate > 0 && dataSize > 0) return dataSize / byteRate;
    if (sampleRate > 0 && dataSize > 0) {
      // Assume 16-bit mono if byteRate missing.
      return dataSize / (sampleRate * 2);
    }
    return 0;
  }
}
