import { AsyncLocalStorage } from "async_hooks";
import { NextFunction, Request, Response } from "express";

export type KitLabsPlatform = "App" | "Web";

const PLATFORM_HEADER = "x-kitlabs-platform";

const store = new AsyncLocalStorage<{ platform: KitLabsPlatform }>();

export function parseKitLabsPlatform(raw: unknown): KitLabsPlatform | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "app") return "App";
  if (normalized === "web") return "Web";
  return null;
}

export function defaultKitLabsPlatform(): KitLabsPlatform {
  return process.env.KITLABS_DESKTOP === "1" ? "App" : "Web";
}

export function kitLabsPlatformMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const fromHeader = parseKitLabsPlatform(req.headers[PLATFORM_HEADER]);
  const platform = fromHeader ?? defaultKitLabsPlatform();
  store.run({ platform }, next);
}

export function getRequestPlatform(): KitLabsPlatform {
  return store.getStore()?.platform ?? defaultKitLabsPlatform();
}

export function isAppPlatform(): boolean {
  return getRequestPlatform() === "App";
}
