import { BadRequestException } from "@nestjs/common";

export function validateApiServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new BadRequestException("Invalid API Server URL");
  }
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))
  ) {
    throw new BadRequestException("API Server must use HTTPS");
  }
  return url.toString().replace(/\/+$/, "").replace(/\/api$/, "");
}

export function buildOAuthAppRedirect(
  provider: "facebook" | "tiktok",
  result: { status: "success" | "error"; ticket?: string },
): string {
  const params = new URLSearchParams({ status: result.status });
  if (result.ticket) {
    params.set("ticket", result.ticket);
  }
  return `kitlabs://oauth/${provider}?${params.toString()}`;
}

