import { createHash } from "node:crypto";
import type { Collection, Db, Filter } from "mongodb";

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

export interface CacheListOptions {
  queryPrefix?: string;
  keyPrefix?: string;
  limit?: number;
}

export interface CacheListEntry {
  key: string;
  value: unknown;
  createdAt: Date;
}

export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number, status?: number): Promise<void>;
  listRecent(options?: CacheListOptions): Promise<CacheListEntry[]>;
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
  private readonly entries = new Map<string, { value: unknown; expiresAt: number; createdAt: number }>();
  private lastCreatedAt = 0;

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
    const createdAt = Math.max(Date.now(), this.lastCreatedAt + 1);
    this.lastCreatedAt = createdAt;
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs, createdAt });
  }

  async listRecent(options: CacheListOptions = {}): Promise<CacheListEntry[]> {
    const now = Date.now();
    const matches: CacheListEntry[] = [];
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(key);
        continue;
      }
      if (!matchesListOptions(key, entry.value, options)) {
        continue;
      }
      matches.push({ key, value: entry.value, createdAt: new Date(entry.createdAt) });
    }
    matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return matches.slice(0, options.limit ?? 8);
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
    await collection.createIndex({ source: 1, createdAt: -1 });
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

  async listRecent(options: CacheListOptions = {}): Promise<CacheListEntry[]> {
    const limit = options.limit ?? 8;
    const filter: Record<string, unknown> = {
      source: this.source,
      expiresAt: { $gt: new Date() },
    };
    const or: Record<string, unknown>[] = [];
    if (options.queryPrefix) {
      or.push({ "value.query": { $regex: `^${escapeRegex(options.queryPrefix)}`, $options: "i" } });
    }
    if (options.keyPrefix) {
      or.push({ _id: { $regex: `^${escapeRegex(options.keyPrefix)}` } });
    }
    if (or.length > 0) {
      filter.$or = or;
    }
    const docs = await this.collection
      .find(filter as Filter<FdcCacheDocument>)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({ key: doc._id, value: doc.value, createdAt: doc.createdAt }));
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

function matchesListOptions(key: string, value: unknown, options: CacheListOptions): boolean {
  if (!options.queryPrefix && !options.keyPrefix) {
    return true;
  }
  if (options.keyPrefix && key.startsWith(options.keyPrefix)) {
    return true;
  }
  if (options.queryPrefix && value && typeof value === "object" && "query" in value) {
    const query = (value as { query: unknown }).query;
    if (typeof query === "string") {
      const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
      if (normalized.startsWith(options.queryPrefix)) {
        return true;
      }
    }
  }
  return false;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
