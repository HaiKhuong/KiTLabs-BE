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
