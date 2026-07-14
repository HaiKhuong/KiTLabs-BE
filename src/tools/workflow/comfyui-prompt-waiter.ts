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

export class ComfyPromptWaiter {
  private ws: WebSocket | null = null;
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
  ) {}

  async connect(): Promise<void> {
    this.logger.log(`[ComfyUI] WS connecting`);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.once("open", () => {
        this.logger.log(`[ComfyUI] WS connected`);
        resolve();
      });
      ws.once("error", (err) => {
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  waitFor(promptId: string): Promise<void> {
    const ws = this.ws;
    if (!ws) {
      return Promise.reject(new Error("ComfyUI WebSocket is not connected"));
    }

    return new Promise<void>((resolve, reject) => {
      const finish = (err?: Error) => {
        if (this.settled) return;
        this.settled = true;
        if (this.timer) clearTimeout(this.timer);
        try {
          ws.close();
        } catch {
          /* best-effort */
        }
        this.ws = null;
        if (err) reject(err);
        else resolve();
      };

      this.timer = setTimeout(() => {
        finish(
          new Error(`ComfyUI timeout ${this.timeoutMs}ms — prompt_id=${promptId}`),
        );
      }, this.timeoutMs);

      ws.on("message", (raw) => {
        let msg: ComfyWsMessage;
        try {
          msg = JSON.parse(raw.toString()) as ComfyWsMessage;
        } catch {
          return;
        }

        const data = msg.data;
        if (!data || data.prompt_id !== promptId) return;

        if (msg.type === "executing" && data.node == null) {
          this.logger.log(`[ComfyUI] prompt_id=${promptId} done (WS)`);
          finish();
          return;
        }

        if (msg.type === "execution_error") {
          finish(new Error(data.exception_message ?? "ComfyUI execution failed"));
        }
      });

      ws.on("close", () => {
        if (!this.settled) {
          finish(new Error(`ComfyUI WS closed — prompt_id=${promptId}`));
        }
      });

      ws.on("error", (err) => {
        if (!this.settled) {
          finish(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* best-effort */
      }
      this.ws = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
