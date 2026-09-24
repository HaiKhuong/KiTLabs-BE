import { isAbsolute, join, resolve } from "path";

export function kitlabsDataRoot(): string | undefined {
  const raw = process.env.KITLABS_DATA_ROOT?.trim();
  return raw || undefined;
}

/**
 * Resolve a configurable directory.
 * Absolute env wins; otherwise join KITLABS_DATA_ROOT (desktop) or cwd (web/docker).
 */
export function resolveConfiguredPath(envValue: string | undefined, relativeDefault: string): string {
  const raw = envValue?.trim();
  if (raw) {
    if (isAbsolute(raw)) {
      return resolve(raw);
    }
    return resolve(kitlabsDataRoot() ?? process.cwd(), raw);
  }
  const root = kitlabsDataRoot();
  if (root) {
    return resolve(root, relativeDefault);
  }
  return resolve(process.cwd(), relativeDefault);
}

export function resolveDataSubdir(...segments: string[]): string {
  const root = kitlabsDataRoot();
  if (root) {
    return join(root, ...segments);
  }
  return join(process.cwd(), ...segments);
}

/**
 * Folder for every translate step (logs, srt, video, Open Folder).
 * Runtime "Translate work folder" (`TRANSLATE_WORK_ROOT`) wins over the desktop staging default.
 */
export function resolveTranslateWorkRoot(): string {
  const output = process.env.TRANSLATE_WORK_ROOT?.trim();
  const staging = process.env.TRANSLATE_WORK_STAGING_ROOT?.trim();
  return resolveConfiguredPath(output || staging, "videos");
}

export function resolveRecapWorkRoot(): string {
  return resolveConfiguredPath(process.env.RECAP_WORK_ROOT?.trim(), "uploads/recap");
}

export function resolveShortVideoWorkRoot(): string {
  return resolveConfiguredPath(process.env.SHORTVIDEO_WORK_ROOT?.trim(), "uploads/shortvideo");
}

export function resolveWhiteboardWorkRoot(): string {
  return resolveConfiguredPath(process.env.WHITEBOARD_WORK_ROOT?.trim(), "uploads/whiteboard");
}

export function resolveNarratoWorkRoot(): string {
  return resolveConfiguredPath(
    process.env.NARRATO_WORK_ROOT?.trim() || process.env.RECAP_WORK_ROOT?.trim(),
    "uploads/narrato",
  );
}
