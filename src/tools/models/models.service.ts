import { spawn } from "child_process";
import { existsSync, readdirSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from "@nestjs/common";

import { AppConfigService } from "../../common/config/app-config.service";
import { pythonBinExists, resolvePythonBin } from "../../common/desktop/python-path";
import { ToolsRealtimeGateway } from "../realtime/tools-realtime.gateway";
import { resolveConfiguredPath } from "../../common/desktop/data-path";

export type AiModelId = "whisper-large-v3" | "omnivoice" | "voxcpm2";

export type AiModelCatalogItem = {
  id: AiModelId;
  repoId: string;
  label: string;
  gated: boolean;
};

export const AI_MODEL_CATALOG: AiModelCatalogItem[] = [
  { id: "whisper-large-v3", repoId: "Systran/faster-whisper-large-v3", label: "Whisper large-v3", gated: false },
  { id: "omnivoice", repoId: "k2-fsa/OmniVoice", label: "OmniVoice", gated: true },
  { id: "voxcpm2", repoId: "openbmb/VoxCPM2", label: "VoxCPM2", gated: false },
];

function hubFolder(repoId: string): string {
  return `models--${repoId.replace("/", "--")}`;
}

function dirSizeBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const walk = (p: string) => {
    for (const name of readdirSync(p, { withFileTypes: true })) {
      const next = join(p, name.name);
      if (name.isDirectory()) walk(next);
      else {
        try {
          total += statSync(next).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

@Injectable()
export class ModelsService {
  private readonly logger = new Logger(ModelsService.name);
  private downloading = new Set<string>();

  constructor(
    private readonly realtimeGateway: ToolsRealtimeGateway,
    private readonly appConfig: AppConfigService,
  ) {}

  cacheHub(): string {
    const cacheRoot = resolveConfiguredPath(process.env.KITLABS_PYTHON_CACHE_DIR, "cache");
    return join(cacheRoot, "huggingface", "hub");
  }

  status() {
    const hub = this.cacheHub();
    return AI_MODEL_CATALOG.map((item) => {
      const path = join(hub, hubFolder(item.repoId));
      const installed = existsSync(path);
      return {
        ...item,
        installed,
        path,
        sizeBytes: installed ? dirSizeBytes(path) : 0,
        downloading: this.downloading.has(item.id),
      };
    });
  }

  isInstalled(id: AiModelId): boolean {
    const row = this.status().find((s) => s.id === id);
    return Boolean(row?.installed);
  }

  requiredModelsForTranslate(engineConfig: Record<string, unknown> | null | undefined, stepNbr: number[]): AiModelId[] {
    const needed: AiModelId[] = [];
    const source = String(engineConfig?.step1SubtitleSource ?? engineConfig?.subtitleSource ?? "whisper");
    if (stepNbr.includes(1) && source === "whisper") {
      needed.push("whisper-large-v3");
    }
    const tts = String(engineConfig?.step3TtsEngine ?? engineConfig?.ttsEngine ?? "");
    if (stepNbr.includes(3) && tts === "omnivoice") needed.push("omnivoice");
    if (stepNbr.includes(3) && (tts === "voxcpm2" || tts === "voxcpm")) needed.push("voxcpm2");
    return needed;
  }

  assertInstalled(ids: AiModelId[]): void {
    const missing = ids.filter((id) => !this.isInstalled(id));
    if (missing.length === 0) return;
    throw new HttpException(
      {
        statusCode: HttpStatus.CONFLICT,
        code: "MODEL_REQUIRED",
        message: "AI model is not downloaded yet",
        modelIds: missing,
      },
      HttpStatus.CONFLICT,
    );
  }

  private shouldDownloadViaNode(): boolean {
    if (process.env.MODELS_DOWNLOAD_VIA_NODE === "1") return true;
    if (process.env.MODELS_DOWNLOAD_VIA_NODE === "0") return false;
    const pythonBin = resolvePythonBin();
    return !pythonBinExists(pythonBin);
  }

  async download(ids: string[], userId?: string): Promise<{ started: string[] }> {
    const valid = ids.filter((id): id is AiModelId => AI_MODEL_CATALOG.some((c) => c.id === id));
    if (valid.length === 0) {
      throw new BadRequestException("No valid model ids");
    }

    const useNode = this.shouldDownloadViaNode();
    const pythonBin = resolvePythonBin();
    const scriptRaw = process.env.TRANSLATE_PYTHON_SCRIPT ?? "tools/video-pipeline/auto_vietsub_pro.py";
    const scriptPath = isAbsolute(scriptRaw) ? scriptRaw : resolve(process.cwd(), scriptRaw);
    const downloadScript = join(dirname(scriptPath), "download_hf_model.py");

    if (!useNode && !existsSync(downloadScript)) {
      throw new BadRequestException(`download_hf_model.py not found next to pipeline (${downloadScript})`);
    }

    for (const id of valid) {
      if (this.downloading.has(id)) continue;
      this.downloading.add(id);
      const item = AI_MODEL_CATALOG.find((c) => c.id === id)!;
      const task = useNode
        ? this.runDownloadViaNode(item, userId)
        : this.runDownloadViaPython(pythonBin, downloadScript, item, userId);
      void task.finally(() => {
        this.downloading.delete(id);
      });
    }
    return { started: valid };
  }

  private notifyProgress(item: AiModelCatalogItem, userId: string | undefined, text: string): void {
    this.realtimeGateway.notifyUser(userId ?? "all", "models.download.progress", {
      id: item.id,
      repoId: item.repoId,
      text,
    });
  }

  private notifyDone(
    item: AiModelCatalogItem,
    userId: string | undefined,
    ok: boolean,
    code: number,
  ): void {
    this.realtimeGateway.notifyUser(
      userId ?? "all",
      ok ? "models.download.completed" : "models.download.failed",
      {
        id: item.id,
        repoId: item.repoId,
        code,
      },
    );
  }

  private async runDownloadViaNode(item: AiModelCatalogItem, userId?: string): Promise<void> {
    const hfToken = this.appConfig.getSecret("HF_TOKEN").trim() || undefined;
    this.notifyProgress(item, userId, `DOWNLOAD_START repo=${item.repoId}\n`);

    try {
      const { snapshotDownload } = await import("@huggingface/hub");
      await snapshotDownload({
        repo: item.repoId,
        cacheDir: this.cacheHub(),
        accessToken: hfToken,
      });
      this.notifyProgress(item, userId, `DOWNLOAD_DONE repo=${item.repoId}\n`);
      this.notifyDone(item, userId, true, 0);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Node model download failed (${item.id}): ${message}`);
      this.notifyProgress(item, userId, `DOWNLOAD_FAILED ${message}\n`);
      this.notifyDone(item, userId, false, 1);
      throw err instanceof Error ? err : new Error(message);
    }
  }

  private runDownloadViaPython(
    pythonBin: string,
    script: string,
    item: AiModelCatalogItem,
    userId?: string,
  ): Promise<void> {
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const hfToken = this.appConfig.getSecret("HF_TOKEN").trim();
      const child = spawn(pythonBin, [script, "--repo", item.repoId, "--cache-dir", this.cacheHub()], {
        windowsHide: true,
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          ...(hfToken ? { HF_TOKEN: hfToken, HUGGING_FACE_HUB_TOKEN: hfToken } : {}),
        },
      });
      child.stdout?.on("data", (buf: Buffer) => {
        this.notifyProgress(item, userId, buf.toString("utf8"));
      });
      child.stderr?.on("data", (buf: Buffer) => {
        this.notifyProgress(item, userId, buf.toString("utf8"));
      });
      child.on("error", (err: Error) => {
        this.notifyDone(item, userId, false, 1);
        rejectPromise(err);
      });
      child.on("exit", (code) => {
        const ok = code === 0;
        this.notifyDone(item, userId, ok, code ?? 1);
        if (ok) resolvePromise();
        else rejectPromise(new Error(`download ${item.id} exited ${code ?? "?"}`));
      });
    });
  }
}
