import type { Queue } from "bullmq";

export class RenderCancelledError extends Error {
  readonly cancelled = true;

  constructor(message = "Cancelled by user") {
    super(message);
    this.name = "RenderCancelledError";
  }
}

export function isRenderCancelledError(error: unknown): boolean {
  if (error instanceof RenderCancelledError) return true;
  return error instanceof Error && (error.name === "RenderCancelledError" || error.message === "Cancelled by user");
}

export function shouldDeleteRenderFiles(): boolean {
  const raw = (process.env.RENDER_CANCEL_DELETE_FILES ?? "true").trim().toLowerCase();
  if (!raw) return true;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export const RenderJobKeys = {
  translate: (id: string) => `translate:${id}`,
  recap: (id: string) => `recap:${id}`,
  narrato: (id: string) => `narrato:${id}`,
  audio: (id: string) => `audio:${id}`,
  shortvideo: (id: string) => `shortvideo:${id}`,
  whiteboard: (id: string) => `whiteboard:${id}`,
} as const;

export const CANCELLED_BY_USER_MESSAGE = "Đã hủy bởi người dùng";

export async function discardQueueJob(queue: Queue, queueJobId: string | null | undefined): Promise<void> {
  const id = String(queueJobId ?? "").trim();
  if (!id) return;
  try {
    const job = await queue.getJob(id);
    if (!job) return;
    const state = await job.getState();
    if (state === "waiting" || state === "delayed") {
      await job.remove();
      return;
    }
    if (state === "active") {
      try {
        await job.discard();
      } catch {
        /* worker will exit via cancel flag */
      }
    }
  } catch {
    /* queue entry may already be gone */
  }
}

export type CancelRenderResult = {
  status: "cancelled";
  cancelled: true;
  deletedFiles: boolean;
};
