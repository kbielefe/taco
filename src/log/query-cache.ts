import { createHash } from "node:crypto";
import type { CacheListEntry } from "../fdc/cache.js";
import type { FoodLogMacros, FoodLogResolution, FoodLogSuggestion } from "./types.js";

export const QUERY_CACHE_PREFIX = "food-log:v1:query:";
const HASHED_KEY = /^[0-9a-f]{64}$/;

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

export function queryCacheKey(query: string): string {
  const normalized = normalizeQuery(query);
  const raw = `${QUERY_CACHE_PREFIX}${normalized}`;
  if (raw.length <= 1024) {
    return raw;
  }
  return `${QUERY_CACHE_PREFIX}${createHash("sha256").update(normalized).digest("hex")}`;
}

export function queryFromCacheKey(key: string): string | undefined {
  if (!key.startsWith(QUERY_CACHE_PREFIX)) {
    return undefined;
  }
  const rest = key.slice(QUERY_CACHE_PREFIX.length);
  if (HASHED_KEY.test(rest)) {
    return undefined;
  }
  return rest;
}

export function cacheResolution(query: string, resolution: FoodLogResolution): FoodLogResolution & { query: string } {
  return { query, ...resolution };
}

export function suggestionFromCacheEntry(entry: CacheListEntry): FoodLogSuggestion | undefined {
  if (!entry.value || typeof entry.value !== "object") {
    return undefined;
  }
  const value = entry.value as Partial<FoodLogResolution> & { query?: unknown };
  if (typeof value.description !== "string" || !isMacros(value.macros)) {
    return undefined;
  }
  const storedQuery = typeof value.query === "string" ? value.query.trim() : "";
  const query = storedQuery || queryFromCacheKey(entry.key);
  if (!query) {
    return undefined;
  }
  return {
    query,
    description: value.description,
    macros: value.macros,
  };
}

function isMacros(value: unknown): value is FoodLogMacros {
  if (!value || typeof value !== "object") {
    return false;
  }
  const macros = value as FoodLogMacros;
  return (
    typeof macros.caloriesKcal === "number" &&
    typeof macros.proteinG === "number" &&
    typeof macros.fatG === "number" &&
    typeof macros.carbG === "number" &&
    typeof macros.fiberG === "number"
  );
}
