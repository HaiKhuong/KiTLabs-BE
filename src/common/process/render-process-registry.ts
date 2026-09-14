import { Injectable, Logger } from "@nestjs/common";
import type { ChildProcess } from "child_process";

import { killProcessTree } from "./kill-process-tree";

export type RenderProcessHandle = {
  child?: ChildProcess;
  onCancel?: () => void;
};

@Injectable()
export class RenderProcessRegistry {
  private readonly logger = new Logger(RenderProcessRegistry.name);
  private readonly cancelled = new Set<string>();
  private readonly handles = new Map<string, RenderProcessHandle[]>();

  /** Call when a new job starts so a previous cancel flag does not leak. */
  begin(key: string): void {
    this.cancelled.delete(key);
    this.handles.delete(key);
  }

  register(key: string, handle: RenderProcessHandle): void {
    const list = this.handles.get(key) ?? [];
    list.push(handle);
    this.handles.set(key, list);
  }

  requestCancel(key: string): void {
    this.cancelled.add(key);
    const list = this.handles.get(key) ?? [];
    this.logger.warn(`Cancelling render process ${key} (${list.length} handle(s))`);
    for (const handle of list) {
      try {
        handle.onCancel?.();
      } catch (err) {
        this.logger.warn(`onCancel failed for ${key}: ${String(err)}`);
      }
      if (handle.child?.pid) {
        killProcessTree(handle.child.pid);
      }
    }
  }

  isCancelled(key: string): boolean {
    return this.cancelled.has(key);
  }

  /** Drop live handles; keep the cancelled flag until the next begin(). */
  release(key: string): void {
    this.handles.delete(key);
  }
}
