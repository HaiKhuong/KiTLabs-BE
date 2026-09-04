import { existsSync } from "fs";
import { isAbsolute, join } from "path";

function firstExisting(paths: string[]): string | undefined {
  for (const candidate of paths) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve Python for pipeline / model scripts on desktop and server. */
export function resolvePythonBin(preferredEnvKeys: string[] = ["TRANSLATE_PYTHON_BIN"]): string {
  for (const key of preferredEnvKeys) {
    const raw = process.env[key]?.trim();
    if (!raw) continue;
    if (isAbsolute(raw)) {
      if (existsSync(raw)) return raw;
      continue;
    }
    return raw;
  }

  if (process.env.KITLABS_DESKTOP === "1") {
    const dataRoot = process.env.KITLABS_DATA_ROOT?.trim();
    if (dataRoot) {
      const userPy = firstExisting([
        join(dataRoot, "sidecars", "python", "Scripts", "python.exe"),
        join(dataRoot, "sidecars", "python", "bin", "python"),
      ]);
      if (userPy) return userPy;
    }

    const cwd = process.cwd();
    const bundled = firstExisting([
      join(cwd, "..", "python", "Scripts", "python.exe"),
      join(cwd, "..", "python", "bin", "python"),
      join(cwd, "resources", "python", "Scripts", "python.exe"),
      join(cwd, "resources", "python", "bin", "python"),
    ]);
    if (bundled) return bundled;
  }

  return process.platform === "win32" ? "py" : "python3";
}

export function pythonBinExists(bin: string): boolean {
  if (isAbsolute(bin)) return existsSync(bin);
  return false;
}

/** Env for child Python on Windows — UTF-8 stdin/stdout/stderr (tránh mojibake tiếng Việt). */
export function pythonSubprocessEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
}
