import { Logger } from "@nestjs/common";
import WebSocket from "ws";

type ComfyWsMessage = {
  type?: string;
  data?: {
    prompt_id?: string;
    node?: string | null;
    exception_message?: string;
  };
};

const QUIET_WS_TYPES = new Set([
  "progress",
  "progress_state",
  "status",
  "execution_start",
  "execution_cached",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeCloseCode(code: number): string {
  switch (code) {
    case 1000:
      return "normal closure";
    case 1001:
      return "going away (server/container stopping)";
    case 1006:
      return "abnormal (network drop, proxy timeout, container restart — no close frame)";
    case 1011:
      return "server error";
    case 1012:
      return "service restart";
    case 1013:
      return "try again later";
    default:
      return `code ${code}`;
  }
}

function formatCloseDetail(code: number, reason: Buffer): string {
  const reasonText = reason.length > 0 ? reason.toString("utf8") : "(none)";
  return `code=${code} (${describeCloseCode(code)}) reason=${reasonText}`;
}

export function isRecoverableComfyWaitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("WebSocket closed before prompt completed") ||
    msg.includes("WebSocket timed out") ||
    msg.includes("ECONNRESET") ||
    msg.includes("socket hang up")
  );
}

export class ComfyPromptWaiter {
  private ws: WebSocket | null = null;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    this.logger.log(`[ComfyUI] Start Comfy — connecting WebSocket`);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      ws.once("open", () => {
        this.logger.log(`[ComfyUI] Start Comfy — WebSocket connected`);
        this.startPing(ws);
        resolve();
      });

      ws.once("error", (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  async waitFor(promptId: string): Promise<void> {
    const deadline = Date.now() + this.timeoutMs;
    const reconnectEnabled = (process.env.COMFYUI_WS_RECONNECT ?? "1") !== "0";
    const runningLogged = { value: false };

    this.logger.log(`[ComfyUI] Start Comfy — waiting prompt_id=${promptId}`);

    while (Date.now() < deadline) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        await this.connect();
      }

      try {
        await this.waitForOnce(promptId, deadline, runningLogged);
        return;
      } catch (err) {
        if (!isRecoverableComfyWaitError(err)) {
          throw err;
        }

        const remainingMs = deadline - Date.now();
        if (!reconnectEnabled || remainingMs <= 0) {
          throw err;
        }

        this.logger.warn(
          `[ComfyUI] WS dropped (${err instanceof Error ? err.message : String(err)}) — reconnect (${Math.round(remainingMs / 1000)}s left)`,
        );
        await this.reconnect();
      }
    }

    throw new Error(
      `ComfyUI WebSocket timed out after ${this.timeoutMs}ms — prompt_id=${promptId}`,
    );
  }

  close(): void {
    this.resetConnection();
  }

  private async reconnect(): Promise<void> {
    this.resetConnection();
    const delayMs = Number(process.env.COMFYUI_WS_RECONNECT_DELAY_MS ?? 1_000);
    await sleep(delayMs);
    await this.connect();
  }

  private resetConnection(): void {
    this.settled = false;
    this.stopPing();
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        // best-effort
      }
      this.ws = null;
    }
  }

  private waitForOnce(
    promptId: string,
    deadlineMs: number,
    runningLogged: { value: boolean },
  ): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return Promise.reject(new Error("ComfyUI WebSocket is not connected"));
    }

    return new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        if (this.settled) return;
        this.settled = true;
        this.stopPing();
        if (this.timer) clearTimeout(this.timer);
        try {
          ws.close();
        } catch {
          // best-effort
        }
        this.ws = null;
        if (err) reject(err);
        else resolve();
      };

      const remainingMs = Math.max(0, deadlineMs - Date.now());
      this.timer = setTimeout(() => {
        finish(
          new Error(
            `ComfyUI WebSocket timed out after ${this.timeoutMs}ms — prompt_id=${promptId}`,
          ),
        );
      }, remainingMs);

      ws.on("message", (raw) => {
        let msg: ComfyWsMessage;
        try {
          msg = JSON.parse(raw.toString()) as ComfyWsMessage;
        } catch {
          return;
        }

        const data = msg.data;
        if (!data || data.prompt_id !== promptId) return;

        const msgType = msg.type ?? "unknown";

        if (msg.type === "executing" && data.node != null) {
          if (!runningLogged.value) {
            runningLogged.value = true;
            this.logger.log(`[ComfyUI] Comfy Process — prompt_id=${promptId} running`);
          }
          return;
        }

        if (msg.type === "executing" && data.node == null) {
          this.logger.log(`[ComfyUI] Comfy Process — prompt_id=${promptId} done`);
          finish();
          return;
        }

        if (msg.type === "execution_success") {
          if (!this.settled) {
            this.logger.log(`[ComfyUI] Comfy Process — prompt_id=${promptId} done`);
          }
          finish();
          return;
        }

        if (msg.type === "execution_cached") {
          return;
        }

        if (msg.type === "execution_error") {
          finish(new Error(data.exception_message ?? "ComfyUI execution failed"));
          return;
        }

        if (!QUIET_WS_TYPES.has(msgType)) {
          this.logger.log(
            `[ComfyUI] Receive message Comfy — type=${msgType} prompt_id=${promptId}`,
          );
        }
      });

      ws.on("close", (code, reason) => {
        if (!this.settled) {
          finish(
            new Error(
              `ComfyUI WebSocket closed before prompt completed — prompt_id=${promptId} — ${formatCloseDetail(code, reason)}`,
            ),
          );
        }
      });

      ws.on("error", (err) => {
        if (!this.settled) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private startPing(ws: WebSocket): void {
    const intervalMs = Number(process.env.COMFYUI_WS_PING_MS ?? 15_000);
    if (intervalMs <= 0) return;

    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, intervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
