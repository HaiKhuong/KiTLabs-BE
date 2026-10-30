import { spawn, type ChildProcess } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { basename, extname, join } from "path";

import { InjectQueue } from "@nestjs/bullmq";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { Queue } from "bullmq";

import { pythonSubprocessEnv, resolvePythonBin } from "../../common/desktop/python-path";
import { QueueJobStatus } from "../../common/enums/domain.enums";
import {
  DEFAULT_CONVERT_QUALITY,
  IMAGE_CONVERT_FORMATS,
  IMAGE_EDIT_ALLOWED_EXT,
  type ImageConvertFormat,
  IMAGE_EDIT_DOMAINS,
  IMAGE_EDIT_FEATURES,
  IMAGE_EDIT_QUEUE_NAME,
  IMAGE_EDIT_SCALES,
  imageEditScriptPath,
  resolveImageEditModelsDir,
  type ImageEditDomain,
  type ImageEditFeature,
  type ImageEditScale,
} from "./image-edit.constants";
import { ImageEditHistoryService, type ImageEditClientJob } from "./image-edit-history.service";
import type {
  ImageEditDetection,
  ImageEditFileMeta,
  ImageEditOptions,
  ImageEditStats,
} from "./image-edit-history.entity";

const MAX_LOG_BUFFER = 80_000;
const PYTHON_TIMEOUT_MS = 30 * 60 * 1000;

type PythonResult = {
  ok?: boolean;
  error?: string;
  resultFile?: string | null;
  files?: ImageEditFileMeta[];
  detections?: ImageEditDetection[];
  stats?: ImageEditStats;
};

@Injectable()
export class ImageEditService {
  private readonly logger = new Logger(ImageEditService.name);

  constructor(
    @InjectQueue(IMAGE_EDIT_QUEUE_NAME) private readonly queue: Queue,
    private readonly historyService: ImageEditHistoryService,
  ) {}

  async submit(input: {
    userId: string;
    feature: string;
    scale?: string;
    domain?: string;
    targetFormat?: string;
    quality?: string | number;
    lossless?: string | boolean;
    originalName: string;
    bytes: Buffer;
  }): Promise<{ jobId: string; status: "queued" }> {
    const feature = this.parseFeature(input.feature);
    const options = this.parseOptions(
      feature,
      input.scale,
      input.domain,
      input.targetFormat,
      input.quality,
      input.lossless,
    );
    const extension = extname(input.originalName).toLowerCase();
    if (!IMAGE_EDIT_ALLOWED_EXT.has(extension)) {
      throw new BadRequestException("Chỉ nhận ảnh png, jpg hoặc webp");
    }
    if (!input.bytes?.length) {
      throw new BadRequestException("Thiếu file ảnh");
    }

    const displayName = basename(input.originalName).slice(0, 255) || `image${extension}`;
    const row = await this.historyService.createPending({
      userId: input.userId,
      feature,
      displayName,
      options,
    });

    const jobDir = this.historyService.jobDir(row);
    mkdirSync(jobDir, { recursive: true });
    const inputFileName = `input${extension}`;
    const inputPath = join(jobDir, inputFileName);
    writeFileSync(inputPath, input.bytes);
    await this.historyService.attachInput(row.id, inputPath, inputFileName);

    const queueJob = await this.queue.add(
      IMAGE_EDIT_QUEUE_NAME,
      { historyId: row.id },
      { attempts: 1, removeOnComplete: true, removeOnFail: 50 },
    );
    if (queueJob.id) {
      await this.historyService.attachQueueJob(row.id, String(queueJob.id));
    }

    return { jobId: row.id, status: "queued" };
  }

  async runJob(historyId: string): Promise<ImageEditClientJob> {
    const row = await this.historyService.getById(historyId);
    if (!row) {
      throw new Error(`Image edit history not found: ${historyId}`);
    }
    if (!row.inputPath) {
      throw new Error("Ảnh đầu vào không còn trên đĩa");
    }

    await this.historyService.markRunning(historyId);
    const jobDir = this.historyService.jobDir(row);
    mkdirSync(jobDir, { recursive: true });
    const modelsDir = resolveImageEditModelsDir();
    mkdirSync(modelsDir, { recursive: true });
    const scriptPath = imageEditScriptPath();
    const pythonBin = resolvePythonBin();
    this.logger.log(`start ${row.feature} ${historyId} python=${pythonBin} script=${scriptPath}`);
    if (!existsSync(scriptPath)) {
      throw new Error(`Không thấy script xử lý ảnh: ${scriptPath}`);
    }

    const payload = {
      op: row.feature,
      input_path: row.inputPath,
      out_dir: jobDir,
      models_dir: modelsDir,
      scale: row.options?.scale ?? 4,
      domain: row.options?.domain ?? "photo",
      target_format: row.options?.targetFormat ?? "webp",
      quality: row.options?.quality ?? DEFAULT_CONVERT_QUALITY,
      lossless: row.options?.lossless ?? false,
    };

    const result = await this.spawnPython(payload);
    if (!result.ok) {
      throw new Error(result.error || "Xử lý ảnh thất bại");
    }

    const resultFileName = result.resultFile ? basename(result.resultFile) : null;
    const options: ImageEditOptions = {
      ...(row.options ?? {}),
      files: result.files ?? [],
      detections: result.detections ?? [],
      stats: result.stats,
    };
    const defaultResultName = row.feature === "convert" ? `result.${row.options?.targetFormat ?? "webp"}` : "result.png";
    const resultPath = row.feature === "cutout" ? jobDir : join(jobDir, resultFileName ?? defaultResultName);
    await this.historyService.markCompleted(historyId, resultPath, resultFileName, options);

    const completed = await this.historyService.getById(historyId);
    if (!completed || completed.status !== QueueJobStatus.COMPLETED) {
      throw new Error("Không lưu được kết quả");
    }
    return this.historyService.mapForClient(completed);
  }

  private spawnPython(payload: Record<string, unknown>): Promise<PythonResult> {
    const scriptPath = imageEditScriptPath();
    const pythonBin = resolvePythonBin();
    const modelsDir = String(payload.models_dir ?? resolveImageEditModelsDir());

    return new Promise((resolvePromise, rejectPromise) => {
      const child: ChildProcess = spawn(pythonBin, [scriptPath], {
        cwd: join(process.cwd(), "tools", "image-pipeline"),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: pythonSubprocessEnv({
          HF_HOME: join(modelsDir, "hf"),
          HUGGINGFACE_HUB_CACHE: join(modelsDir, "hf", "hub"),
          HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        }),
      });

      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        rejectPromise(new Error("Xử lý ảnh quá thời gian (30 phút)"));
      }, PYTHON_TIMEOUT_MS);

      child.stdout?.on("data", (buf: Buffer) => {
        stdout += buf.toString("utf8");
        if (stdout.length > MAX_LOG_BUFFER) stdout = stdout.slice(-MAX_LOG_BUFFER);
      });
      child.stderr?.on("data", (buf: Buffer) => {
        const chunk = buf.toString("utf8");
        stderr += chunk;
        if (stderr.length > MAX_LOG_BUFFER) stderr = stderr.slice(-MAX_LOG_BUFFER);
        const line = chunk.trim();
        if (line) this.logger.log(line.slice(0, 500));
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        const detail = `Không chạy được Python (${pythonBin}): ${err.message}`;
        this.writeErrorLog(String(payload.out_dir), detail);
        this.logger.error(detail);
        rejectPromise(new Error(detail));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const outDir = String(payload.out_dir);
        const fromDisk = this.readResultFile(outDir);
        if (code !== 0) {
          const detail = this.formatPythonFailure(code, fromDisk?.error, stderr, stdout);
          this.writeErrorLog(outDir, detail);
          this.logger.error(detail);
          rejectPromise(new Error(detail));
          return;
        }
        if (!fromDisk) {
          const detail = stderr.trim() || "Python không ghi result.json";
          this.writeErrorLog(outDir, detail);
          this.logger.error(detail);
          rejectPromise(new Error(detail));
          return;
        }
        if (!fromDisk.ok) {
          const detail = fromDisk.error || "Xử lý ảnh thất bại";
          this.writeErrorLog(outDir, detail);
          this.logger.error(detail);
          rejectPromise(new Error(detail));
          return;
        }
        resolvePromise(fromDisk);
      });

      child.stdin?.write(Buffer.from(JSON.stringify(payload), "utf8"));
      child.stdin?.end();
    });
  }

  private formatPythonFailure(
    code: number | null,
    resultError: string | undefined,
    stderr: string,
    stdout: string,
  ): string {
    const head = resultError?.trim() || `Python exited ${code ?? "?"}`;
    const tail = (stderr.trim() || stdout.trim()).slice(-2500);
    if (!tail || tail === head) return head.slice(0, 4000);
    return `${head}\n${tail}`.slice(0, 4000);
  }

  private writeErrorLog(outDir: string, detail: string): void {
    try {
      writeFileSync(join(outDir, "error.log"), detail, "utf8");
    } catch (error) {
      this.logger.warn(`Không ghi được error.log: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private readResultFile(outDir: string): PythonResult | null {
    const path = join(outDir, "result.json");
    try {
      return JSON.parse(readFileSync(path, "utf8")) as PythonResult;
    } catch {
      return null;
    }
  }

  private parseFeature(raw: string): ImageEditFeature {
    if ((IMAGE_EDIT_FEATURES as readonly string[]).includes(raw)) {
      return raw as ImageEditFeature;
    }
    throw new BadRequestException("feature không hợp lệ");
  }

  private parseOptions(
    feature: ImageEditFeature,
    scaleRaw?: string,
    domainRaw?: string,
    targetFormatRaw?: string,
    qualityRaw?: string | number,
    losslessRaw?: string | boolean,
  ): ImageEditOptions {
    if (feature === "upscale") {
    const scale = Number(scaleRaw ?? 4);
    if (!(IMAGE_EDIT_SCALES as readonly number[]).includes(scale)) {
      throw new BadRequestException("scale phải là 2 hoặc 4");
    }
    const domain = (domainRaw ?? "photo").trim();
    if (!(IMAGE_EDIT_DOMAINS as readonly string[]).includes(domain)) {
      throw new BadRequestException("domain phải là photo hoặc anime");
    }
    return { scale: scale as ImageEditScale, domain: domain as ImageEditDomain };
    }

    if (feature === "convert") {
      const targetFormat = (targetFormatRaw || "webp").trim().toLowerCase();
      if (!(IMAGE_CONVERT_FORMATS as readonly string[]).includes(targetFormat)) {
        throw new BadRequestException("targetFormat phải là webp, png hoặc jpeg");
      }
      const lossless = losslessRaw === true || losslessRaw === "true" || losslessRaw === "1";
      let quality =
        qualityRaw !== undefined && qualityRaw !== null && qualityRaw !== ""
          ? Number(qualityRaw)
          : DEFAULT_CONVERT_QUALITY;
      if (!Number.isFinite(quality) || quality < 1 || quality > 100) {
        throw new BadRequestException("quality phải từ 1 đến 100");
      }
      quality = Math.round(quality);
      return {
        targetFormat: targetFormat as ImageConvertFormat,
        quality,
        lossless: lossless || quality === 100,
      };
    }

    return {};
  }
}
