import { spawnSync } from "child_process";

/** Kill a process and its descendants. Windows Python jobs often spawn ffmpeg grandchildren. */
export function killProcessTree(pid: number | undefined | null): void {
  if (pid == null || !Number.isFinite(pid) || pid <= 0) return;

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 5_000).unref();
}
