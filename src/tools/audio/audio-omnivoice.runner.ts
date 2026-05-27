import { spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

export type OmnivoiceRunInput = {
  text: string;
  outWav: string;
  refAudio: string;
  refText: string;
  modelId?: string;
  deviceMap?: string;
  dtype?: string;
  language?: string;
  numStep?: number;
  guidanceScale?: number;
  seed?: number;
};

const MAX_LOG_BUFFER = 4 * 1024 * 1024;

export async function runOmnivoiceTts(input: OmnivoiceRunInput): Promise<string> {
  const pythonBin = process.env.AUDIO_PYTHON_BIN ?? process.env.TRANSLATE_PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
  const scriptPath =
    process.env.AUDIO_PYTHON_SCRIPT ?? join("tools", "video-pipeline", "audio_tts_cli.py");
  const absScriptPath = isAbsolute(scriptPath) ? scriptPath : resolve(process.cwd(), scriptPath);
  if (!existsSync(absScriptPath)) {
    throw new Error(`Audio TTS script not found: ${absScriptPath}`);
  }

  const refAudio = isAbsolute(input.refAudio) ? input.refAudio : resolve(process.cwd(), input.refAudio);
  if (!existsSync(refAudio)) {
    throw new Error(`Reference audio not found: ${refAudio}`);
  }

  const outWav = isAbsolute(input.outWav) ? input.outWav : resolve(process.cwd(), input.outWav);
  const scriptDir = dirname(absScriptPath);
  const timeoutMs = Number(process.env.AUDIO_CMD_TIMEOUT_MS ?? process.env.TRANSLATE_CMD_TIMEOUT_MS ?? 600000);

  const args = [
    absScriptPath,
    "--text",
    input.text,
    "--out",
    outWav,
    "--ref-audio",
    refAudio,
    "--ref-text",
    input.refText ?? "",
    "--dtype",
    input.dtype ?? process.env.OMNIVOICE_DTYPE ?? "float16",
    "--language",
    input.language ?? process.env.OMNIVOICE_LANGUAGE ?? "vietnamese",
    "--num-step",
    String(input.numStep ?? Number(process.env.OMNIVOICE_NUM_STEP ?? 8)),
    "--guidance-scale",
    String(input.guidanceScale ?? Number(process.env.OMNIVOICE_GUIDANCE_SCALE ?? 2)),
  ];

  const modelId = (input.modelId ?? process.env.OMNIVOICE_MODEL_ID ?? "k2-fsa/OmniVoice").trim();
  if (modelId) {
    args.push("--model-id", modelId);
  }
  const deviceMap = (input.deviceMap ?? process.env.OMNIVOICE_DEVICE_MAP ?? "").trim();
  if (deviceMap) {
    args.push("--device-map", deviceMap);
  }
  if (input.seed !== undefined && input.seed !== null) {
    args.push("--seed", String(input.seed));
  }

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, args, {
      cwd: scriptDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });

    let stdout = "";
    let stderr = "";
    const timeoutHandle = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error(`OmniVoice TTS timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const append = (target: "stdout" | "stderr", chunk: string) => {
      if (target === "stdout") {
        stdout += chunk;
        if (stdout.length > MAX_LOG_BUFFER) stdout = stdout.slice(-MAX_LOG_BUFFER);
      } else {
        stderr += chunk;
        if (stderr.length > MAX_LOG_BUFFER) stderr = stderr.slice(-MAX_LOG_BUFFER);
      }
    };

    child.stdout?.on("data", (buf) => append("stdout", buf.toString("utf8")));
    child.stderr?.on("data", (buf) => append("stderr", buf.toString("utf8")));
    child.on("error", (err) => {
      clearTimeout(timeoutHandle);
      rejectPromise(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeoutHandle);
      if (code !== 0) {
        rejectPromise(new Error(stderr.trim() || stdout.trim() || `OmniVoice exited with code ${code}`));
        return;
      }
      resolvePromise();
    });
  });

  if (!existsSync(outWav)) {
    throw new Error(`OmniVoice did not produce output: ${outWav}`);
  }
  return outWav;
}
