import { createHash } from "node:crypto";
import type { Collection, Db } from "mongodb";

export const FDC_CACHE_SOURCE = "usda-fdc";

export const FOOD_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const NOT_FOUND_CACHE_TTL_MS = 60 * 60 * 1000;
export const NOT_FOUND_SENTINEL = { error: "not_found" } as const;

export function isNotFoundSentinel(value: unknown): value is typeof NOT_FOUND_SENTINEL {
  return Boolean(
    value &&
      typeof value === "object" &&
      "error" in value &&
      (value as { error: unknown }).error === "not_found",
  );
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number, status?: number): Promise<void>;
}

export interface FdcCacheDocument {
  _id: string;
  source: string;
  status: number;
  value: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set(key: string, value: unknown, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

export class MongoCacheStore implements CacheStore {
  constructor(
    private readonly collection: Collection<FdcCacheDocument>,
    private readonly source: string = FDC_CACHE_SOURCE,
  ) {}

  static async connect(
    db: Db,
    collectionName = "cache",
    source: string = FDC_CACHE_SOURCE,
  ): Promise<MongoCacheStore> {
    const collection = db.collection<FdcCacheDocument>(collectionName);
    await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    return new MongoCacheStore(collection, source);
  }

  async get<T>(key: string): Promise<T | undefined> {
    const doc = await this.collection.findOne({
      _id: key,
      source: this.source,
      expiresAt: { $gt: new Date() },
    });
    if (!doc) {
      return undefined;
    }
    return doc.value as T;
  }

  async set(key: string, value: unknown, ttlMs: number, status = 200): Promise<void> {
    const now = new Date();
    const doc: FdcCacheDocument = {
      _id: key,
      source: this.source,
      status,
      value,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    };
    await this.collection.replaceOne({ _id: key }, doc, { upsert: true });
  }
}

export function foodCacheKey(
  fdcId: string | number,
  format: string = "full",
  nutrients?: number[],
): string {
  const nutrientPart =
    nutrients && nutrients.length > 0 ? `:n=${[...nutrients].sort((a, b) => a - b).join(",")}` : "";
  return `fdc:v1:food:${fdcId}:${format}${nutrientPart}`;
}

export function listCacheKey(criteria: object): string {
  return boundedKey("fdc:v1:list:", stableStringify(criteria));
}

export function searchCacheKey(criteria: object): string {
  return boundedKey("fdc:v1:search:", stableStringify(criteria));
}

function boundedKey(prefix: string, payload: string): string {
  const raw = `${prefix}${payload}`;
  if (raw.length <= 1024) {
    return raw;
  }
  return `${prefix}${createHash("sha256").update(payload).digest("hex")}`;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, sortValue(v)]);
    return Object.fromEntries(entries);
  }
  return value;
}
