const SECRET_KEY = /(api[_-]?key|secret|password|token|authorization|credential)/i;
const MAX_STRING = 20_000;
const MAX_DEPTH = 8;
const MAX_ARRAY = 200;

function redactString(value: string): string {
  if (value.startsWith("data:")) return "[data-url omitted]";
  if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…[truncated]`;
  return value;
}

export function sanitizeRenderData(input: unknown, depth = 0): unknown {
  if (input == null) return input;
  if (depth > MAX_DEPTH) return "[max-depth]";
  if (typeof input === "string") return redactString(input);
  if (typeof input === "number" || typeof input === "boolean") return input;
  if (Array.isArray(input)) {
    return input.slice(0, MAX_ARRAY).map((item) => sanitizeRenderData(item, depth + 1));
  }
  if (typeof input !== "object") return String(input);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      out[key] = "[redacted]";
      continue;
    }
    out[key] = sanitizeRenderData(value, depth + 1);
  }
  return out;
}

export function asRenderData(input: unknown): Record<string, unknown> {
  const sanitized = sanitizeRenderData(input);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>;
  }
  return { value: sanitized };
}
