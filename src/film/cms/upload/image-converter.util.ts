import { spawn } from "child_process";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { dirname, join, resolve } from "path";
import { pythonSubprocessEnv, resolvePythonBin } from "../../../common/desktop/python-path";

export interface ConvertImageOptions {
  inputPath: string;
  outputDir: string;
  outputFilename: string;
  targetFormat?: string;
  quality?: number;
  lossless?: boolean;
}

export interface ConvertImageResult {
  ok: boolean;
  outputPath: string;
  outputFilename: string;
  sizeBytes: number;
  stats?: {
    originalSize: number;
    resultSize: number;
    savedBytes: number;
    savedPercent: number;
    width: number;
    height: number;
    format: string;
    quality: number;
    lossless: boolean;
  };
}

export function resolveImagePipelineScript(): string {
  const candidates = [
    join(process.cwd(), "tools", "image-pipeline", "image_edit.py"),
    resolve(__dirname, "../../../../tools/image-pipeline/image_edit.py"),
    resolve(__dirname, "../../../../../tools/image-pipeline/image_edit.py"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

/**
 * Convert an image file via tools/image-pipeline/image_edit.py using Pillow.
 */
export function convertImageWithPipeline(options: ConvertImageOptions): Promise<ConvertImageResult> {
  const scriptPath = resolveImagePipelineScript();
  const pythonBin = resolvePythonBin();

  if (!existsSync(scriptPath)) {
    return Promise.reject(new Error(`Không tìm thấy script xử lý ảnh: ${scriptPath}`));
  }

  const pipelineCwd = dirname(scriptPath);

  const payload = {
    op: "convert",
    input_path: options.inputPath,
    out_dir: options.outputDir,
    output_filename: options.outputFilename,
    target_format: options.targetFormat || "webp",
    quality: options.quality ?? 85,
    lossless: options.lossless ?? false,
  };

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, [scriptPath], {
      cwd: pipelineCwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonSubprocessEnv(),
    });

    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(new Error("Quá thời gian chuyển đổi ảnh (60 giây)"));
    }, 60_000);

    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(new Error(`Không thể chạy Python (${pythonBin}): ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const resultPath = join(options.outputDir, "result.json");
      let data: any = null;
      if (existsSync(resultPath)) {
        try {
          data = JSON.parse(readFileSync(resultPath, "utf8"));
          unlinkSync(resultPath);
        } catch {
          // ignore
        }
      }

      if (code !== 0 || !data?.ok) {
        const errorMsg = data?.error || stderr.trim() || `Lỗi chuyển đổi ảnh (exit code ${code})`;
        return rejectPromise(new Error(errorMsg));
      }

      const finalName = data.resultFile || options.outputFilename;
      const finalPath = join(options.outputDir, finalName);
      const sizeBytes = data.stats?.resultSize || 0;

      resolvePromise({
        ok: true,
        outputPath: finalPath,
        outputFilename: finalName,
        sizeBytes,
        stats: data.stats,
      });
    });

    child.stdin?.write(Buffer.from(JSON.stringify(payload), "utf8"));
    child.stdin?.end();
  });
}

