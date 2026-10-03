const PREVIEW_LIMIT = 1_000;
const SECRET = /api[_-]?key|authorization|password|token|secret/i;

export function shouldTraceRequest(path: string): boolean {
  if (path === "/api/health" || path === "/api/events" || path.startsWith("/a2ui/")) {
    return false;
  }
  return path === "/mcp" || path.startsWith("/api/");
}

export function requestInputs(
  method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
): { method: string; path: string; query?: Record<string, string>; body?: unknown } {
  const safeQuery = redactQuery(query);
  return {
    method,
    path,
    ...(Object.keys(safeQuery).length > 0 ? { query: safeQuery } : {}),
    ...(body !== undefined ? { body: redactSecrets(body) } : {}),
  };
}

export function requestPreview(method: string, path: string, query: Record<string, string>, body: unknown): string {
  const base = `${method} ${path}`;
  const text = previewText(body);
  if (text) {
    return `${base} ${text}`.slice(0, PREVIEW_LIMIT);
  }
  const qs = new URLSearchParams(redactQuery(query)).toString();
  return (qs ? `${base}?${qs}` : base).slice(0, PREVIEW_LIMIT);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET.test(key) ? "REDACTED" : redactSecrets(child);
  }
  return out;
}

function previewText(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.query === "string" && record.query.trim()) {
    return record.query.trim();
  }
  if (typeof record.question === "string" && record.question.trim()) {
    return record.question.trim();
  }
  return undefined;
}

function redactQuery(query: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    out[key] = SECRET.test(key) ? "REDACTED" : value;
  }
  return out;
}
