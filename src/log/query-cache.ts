import { createHash } from "node:crypto";

const PREFIX = "food-log:v1:query:";

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function queryCacheKey(query: string): string {
  const normalized = normalizeQuery(query);
  const raw = `${PREFIX}${normalized}`;
  if (raw.length <= 1024) {
    return raw;
  }
  return `${PREFIX}${createHash("sha256").update(normalized).digest("hex")}`;
}
