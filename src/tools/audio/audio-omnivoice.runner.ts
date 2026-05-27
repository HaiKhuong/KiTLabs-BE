import { Logger } from "@nestjs/common";
import { spawn } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { basename, dirname, isAbsolute, join, resolve } from "path";

import { KITLABS_PYTHON_CACHE_ROOT } from "./audio.constants";
import { getOmnivoiceDaemonPool, isOmnivoiceDaemonEnabled } from "./audio-omnivoice.daemon";

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
const omnivoiceLog = new Logger("OmniVoiceRunner");

function logPythonStreamLines(chunk: string, level: "log" | "warn" | "error"): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (level === "warn") omnivoiceLog.warn(trimmed);
    else if (level === "error") omnivoiceLog.error(trimmed);
    else omnivoiceLog.log(trimmed);
  }
}

function buildPythonChildEnv(): NodeJS.ProcessEnv {
  const base = KITLABS_PYTHON_CACHE_ROOT;
  const hf = join(base, "huggingface");
  const torch = join(base, "torch");
  mkdirSync(hf, { recursive: true });
  mkdirSync(torch, { recursive: true });
  return {
    ...process.env,
    ...(process.env.HF_HOME ? {} : { HF_HOME: hf }),
    ...(process.env.TRANSFORMERS_CACHE ? {} : { TRANSFORMERS_CACHE: hf }),
    ...(process.env.XDG_CACHE_HOME ? {} : { XDG_CACHE_HOME: base }),
    ...(process.env.TORCH_HOME ? {} : { TORCH_HOME: torch }),
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
  };
}

/** Một process Python / request (fallback khi daemon tắt hoặc lỗi). */
async function runOmnivoiceTtsSpawn(input: OmnivoiceRunInput): Promise<string> {
  const pythonBin =
    process.env.AUDIO_PYTHON_BIN ?? process.env.TRANSLATE_PYTHON_BIN ?? (process.platform === "win32" ? "py" : "python3");
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

  omnivoiceLog.log(
    [
      "spawn-cli",
      `bin=${pythonBin}`,
      `textLen=${input.text.length}`,
      `ref=${basename(refAudio)}`,
      `out=${outWav}`,
    ].join(" "),
  );

  const startedAt = Date.now();

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(pythonBin, args, {
      cwd: scriptDir,
      windowsHide: true,
      env: buildPythonChildEnv(),
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
        logPythonStreamLines(chunk, "log");
      } else {
        stderr += chunk;
        if (stderr.length > MAX_LOG_BUFFER) stderr = stderr.slice(-MAX_LOG_BUFFER);
        logPythonStreamLines(chunk, "warn");
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
      omnivoiceLog.log(`spawn-cli ok elapsedMs=${Date.now() - startedAt}`);
      resolvePromise();
    });
  });

  if (!existsSync(outWav)) {
    throw new Error(`OmniVoice did not produce output: ${outWav}`);
  }
  return outWav;
}

/**
 * OmniVoice TTS — mặc định dùng daemon (một process Python, cache model như auto_vietsub_pro).
 * Tắt daemon: AUDIO_OMNIVOICE_DAEMON=false
 */
export async function runOmnivoiceTts(input: OmnivoiceRunInput): Promise<string> {
  if (isOmnivoiceDaemonEnabled()) {
    try {
      return await getOmnivoiceDaemonPool().synthesize(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      omnivoiceLog.warn(`daemon failed, fallback spawn-cli: ${message}`);
    }
  }
  return runOmnivoiceTtsSpawn(input);
}
