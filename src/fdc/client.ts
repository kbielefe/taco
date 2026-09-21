import { MongoClient } from "mongodb";
import {
  FdcAuthError,
  FdcBadRequestError,
  FdcConfigError,
  FdcNetworkError,
  FdcNotFoundError,
  FdcRateLimitError,
  FdcResponseError,
  FdcServerError,
  FdcTimeoutError,
} from "./errors.js";
import {
  FOOD_CACHE_TTL_MS,
  isNotFoundSentinel,
  NOT_FOUND_CACHE_TTL_MS,
  NOT_FOUND_SENTINEL,
  SEARCH_CACHE_TTL_MS,
  foodCacheKey,
  listCacheKey,
  MongoCacheStore,
  searchCacheKey,
  type CacheStore,
} from "./cache.js";
import { HourlyRateLimiter, hourlyLimitForKey, parseRetryAfterMs } from "./rate-limit.js";
import type {
  AbridgedFoodItem,
  FdcRateLimitInfo,
  FoodItem,
  FoodListCriteria,
  FoodSearchCriteria,
  GetFoodOptions,
  GetFoodsOptions,
  ListFoodsOptions,
  SearchFoodsOptions,
  SearchResult,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.nal.usda.gov/fdc";
const DEFAULT_TIMEOUT_MS = 20_000;
const HEALTH_DB = "health";
const CACHE_COLLECTION = "cache";
const MAX_FDC_IDS_PER_REQUEST = 20;
const MAX_NUTRIENTS = 25;
const MAX_PAGE_SIZE = 200;
const MAX_RETRIES = 2;

export interface FdcClientOptions {
  apiKey: string;
  cache: CacheStore;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimiter?: HourlyRateLimiter;
}

export interface CreateFdcClientOptions {
  apiKey?: string;
  mongoUri?: string;
  cache?: CacheStore;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  rateLimiter?: HourlyRateLimiter;
}

export class FdcClient {
  private readonly apiKey: string;
  private readonly cache: CacheStore;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly rateLimiter: HourlyRateLimiter;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private mongo?: MongoClient;

  constructor(options: FdcClientOptions) {
    if (!options.apiKey) {
      throw new FdcConfigError("USDA_API_KEY is not set");
    }
    this.apiKey = options.apiKey;
    this.cache = options.cache;
    this.fetchImpl = options.fetch ?? fetch;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimiter =
      options.rateLimiter ?? new HourlyRateLimiter(hourlyLimitForKey(options.apiKey));
  }

  /** Used by `createFdcClient` so `close()` can shut down the driver client. */
  attachMongo(client: MongoClient): void {
    this.mongo = client;
  }

  get rateLimit(): FdcRateLimitInfo {
    return this.rateLimiter.info;
  }

  async close(): Promise<void> {
    await this.mongo?.close();
  }

  async getFood(fdcId: number | string, options: GetFoodOptions = {}): Promise<FoodItem> {
    validateNutrients(options.nutrients);
    const format = options.format ?? "full";
    const key = foodCacheKey(fdcId, format, options.nutrients);
    const path = `/v1/food/${encodeURIComponent(String(fdcId))}`;
    return this.cachedRequest<FoodItem>({
      cacheKey: key,
      ttlMs: FOOD_CACHE_TTL_MS,
      skipCache: options.skipCache,
      cacheNotFound: true,
      method: "GET",
      path,
      query: {
        format,
        nutrients: options.nutrients,
      },
    });
  }

  async getFoods(fdcIds: Array<number | string>, options: GetFoodsOptions = {}): Promise<FoodItem[]> {
    if (fdcIds.length === 0) {
      throw new FdcBadRequestError("fdcIds must contain at least one id");
    }
    validateNutrients(options.nutrients);
    const format = options.format ?? "full";
    const uniqueIds = [...new Set(fdcIds.map(String))];

    const foods: FoodItem[] = [];
    const missing: string[] = [];

    if (!options.skipCache) {
      for (const id of uniqueIds) {
        const cached = await this.cache.get<FoodItem | typeof NOT_FOUND_SENTINEL>(
          foodCacheKey(id, format, options.nutrients),
        );
        if (cached === undefined) {
          missing.push(id);
        } else if (!isNotFoundSentinel(cached)) {
          foods.push(cached);
        }
      }
    } else {
      missing.push(...uniqueIds);
    }

    for (let i = 0; i < missing.length; i += MAX_FDC_IDS_PER_REQUEST) {
      const batch = missing.slice(i, i + MAX_FDC_IDS_PER_REQUEST).map(Number);
      const fetched = await this.request<FoodItem[]>({
        method: "POST",
        path: "/v1/foods",
        body: {
          fdcIds: batch,
          format,
          ...(options.nutrients && options.nutrients.length > 0 ? { nutrients: options.nutrients } : {}),
        },
      });
      if (!Array.isArray(fetched)) {
        throw new FdcResponseError("USDA FDC /foods did not return an array");
      }
      const returned = new Set(fetched.map((food) => String(food.fdcId)));
      for (const food of fetched) {
        foods.push(food);
        await this.cache.set(
          foodCacheKey(food.fdcId, format, options.nutrients),
          food,
          FOOD_CACHE_TTL_MS,
        );
      }
      for (const id of batch) {
        if (!returned.has(String(id))) {
          await this.cache.set(
            foodCacheKey(id, format, options.nutrients),
            NOT_FOUND_SENTINEL,
            NOT_FOUND_CACHE_TTL_MS,
            404,
          );
        }
      }
    }

    const byId = new Map(foods.map((food) => [String(food.fdcId), food]));
    return uniqueIds.flatMap((id) => {
      const food = byId.get(id);
      return food ? [food] : [];
    });
  }

  async listFoods(options: ListFoodsOptions = {}): Promise<AbridgedFoodItem[]> {
    validatePaging(options);
    const criteria = listCriteria(options);
    return this.cachedRequest<AbridgedFoodItem[]>({
      cacheKey: listCacheKey(criteria),
      ttlMs: SEARCH_CACHE_TTL_MS,
      skipCache: options.skipCache,
      method: "POST",
      path: "/v1/foods/list",
      body: criteria,
    });
  }

  async searchFoods(options: SearchFoodsOptions): Promise<SearchResult> {
    if (!options.query || options.query.trim() === "") {
      throw new FdcBadRequestError("search query is required");
    }
    validatePaging(options);
    const criteria = searchCriteria(options);
    return this.cachedRequest<SearchResult>({
      cacheKey: searchCacheKey(criteria),
      ttlMs: SEARCH_CACHE_TTL_MS,
      skipCache: options.skipCache,
      method: "POST",
      path: "/v1/foods/search",
      body: criteria,
    });
  }

  private async cachedRequest<T>(opts: {
    cacheKey: string;
    ttlMs: number;
    skipCache?: boolean;
    cacheNotFound?: boolean;
    method: "GET" | "POST";
    path: string;
    query?: QueryParams;
    body?: unknown;
  }): Promise<T> {
    if (!opts.skipCache) {
      const cached = await this.cache.get<T>(opts.cacheKey);
      if (cached !== undefined) {
        if (isNotFoundSentinel(cached)) {
          throw new FdcNotFoundError("Food not found", { status: 404 });
        }
        return cached;
      }
    }

    const existing = this.inflight.get(opts.cacheKey);
    if (existing) {
      return existing as Promise<T>;
    }

    const pending = this.request<T>({
      method: opts.method,
      path: opts.path,
      query: opts.query,
      body: opts.body,
    })
      .then(async (value) => {
        await this.cache.set(opts.cacheKey, value, opts.ttlMs, 200);
        return value;
      })
      .catch(async (error: unknown) => {
        if (opts.cacheNotFound && error instanceof FdcNotFoundError) {
          await this.cache.set(opts.cacheKey, NOT_FOUND_SENTINEL, NOT_FOUND_CACHE_TTL_MS, 404);
        }
        throw error;
      })
      .finally(() => {
        this.inflight.delete(opts.cacheKey);
      });

    this.inflight.set(opts.cacheKey, pending);
    return pending;
  }

  private async request<T>(opts: {
    method: "GET" | "POST";
    path: string;
    query?: QueryParams;
    body?: unknown;
  }): Promise<T> {
    const url = this.buildUrl(opts.path, opts.query);
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= MAX_RETRIES) {
      this.rateLimiter.acquire();
      try {
        const response = await this.send(url, opts.method, opts.body);
        this.rateLimiter.observeHeaders(response.headers);

        if (response.ok) {
          return (await parseJson(response)) as T;
        }

        const error = await errorFromResponse(response, this.rateLimiter);
        if (error instanceof FdcServerError && attempt < MAX_RETRIES) {
          lastError = error;
          await delay(backoffMs(attempt));
          attempt += 1;
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof FdcTimeoutError || error instanceof FdcNetworkError) {
          if (attempt < MAX_RETRIES) {
            lastError = error;
            await delay(backoffMs(attempt));
            attempt += 1;
            continue;
          }
        }
        throw error;
      }
    }

    throw lastError instanceof Error ? lastError : new FdcServerError("USDA FDC request failed");
  }

  private async send(url: URL, method: "GET" | "POST", body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method,
        headers:
          method === "POST"
            ? { Accept: "application/json", "Content-Type": "application/json" }
            : { Accept: "application/json" },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw new FdcTimeoutError(`USDA FDC request timed out after ${this.timeoutMs}ms`, {
          cause: error,
        });
      }
      throw new FdcNetworkError("Failed to reach the USDA FDC API", { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  private buildUrl(path: string, query?: QueryParams): URL {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("api_key", this.apiKey);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined) {
          continue;
        }
        if (Array.isArray(value)) {
          if (value.length === 0) {
            continue;
          }
          url.searchParams.set(key, value.map(String).join(","));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url;
  }
}

export async function createFdcClient(options: CreateFdcClientOptions = {}): Promise<FdcClient> {
  const apiKey = options.apiKey ?? process.env.USDA_API_KEY;
  if (!apiKey) {
    throw new FdcConfigError("USDA_API_KEY is not set");
  }

  let cache = options.cache;
  let mongo: MongoClient | undefined;
  if (!cache) {
    const uri = options.mongoUri ?? process.env.MONGODB_URI;
    if (!uri) {
      throw new FdcConfigError("MONGODB_URI is not set");
    }
    mongo = new MongoClient(uri);
    await mongo.connect();
    cache = await MongoCacheStore.connect(mongo.db(HEALTH_DB), CACHE_COLLECTION);
  }

  const client = new FdcClient({
    apiKey,
    cache,
    fetch: options.fetch,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
    rateLimiter: options.rateLimiter,
  });
  if (mongo) {
    client.attachMongo(mongo);
  }
  return client;
}

type QueryParams = Record<string, string | number | Array<string | number> | undefined>;

function listCriteria(options: ListFoodsOptions): FoodListCriteria {
  return omitUndefined({
    dataType: options.dataType,
    pageSize: options.pageSize,
    pageNumber: options.pageNumber,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
  });
}

function searchCriteria(options: SearchFoodsOptions): FoodSearchCriteria {
  return omitUndefined({
    query: options.query,
    dataType: options.dataType,
    pageSize: options.pageSize,
    pageNumber: options.pageNumber,
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
    brandOwner: options.brandOwner,
  });
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function validateNutrients(nutrients?: number[]): void {
  if (!nutrients) {
    return;
  }
  if (nutrients.length === 0 || nutrients.length > MAX_NUTRIENTS) {
    throw new FdcBadRequestError(`nutrients must contain between 1 and ${MAX_NUTRIENTS} values`);
  }
}

function validatePaging(options: { pageSize?: number; pageNumber?: number }): void {
  if (options.pageSize !== undefined && (options.pageSize < 1 || options.pageSize > MAX_PAGE_SIZE)) {
    throw new FdcBadRequestError(`pageSize must be between 1 and ${MAX_PAGE_SIZE}`);
  }
  if (options.pageNumber !== undefined && options.pageNumber < 0) {
    throw new FdcBadRequestError("pageNumber must be >= 0");
  }
}

async function parseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new FdcResponseError("USDA FDC returned a non-JSON response", {
      status: response.status,
      cause: error,
    });
  }
}

async function errorFromResponse(response: Response, limiter: HourlyRateLimiter): Promise<Error> {
  const bodyText = await response.text();
  const message = extractErrorMessage(bodyText) ?? `USDA FDC request failed with HTTP ${response.status}`;

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    limiter.blockFor(retryAfterMs);
    return new FdcRateLimitError(message, retryAfterMs, { status: 429 });
  }
  if (response.status === 401 || response.status === 403) {
    return new FdcAuthError(message, { status: response.status });
  }
  if (response.status === 404) {
    return new FdcNotFoundError(message, { status: 404 });
  }
  if (response.status === 400) {
    return new FdcBadRequestError(message, { status: 400 });
  }
  if (response.status >= 500) {
    return new FdcServerError(message, { status: response.status });
  }
  return new FdcResponseError(message, { status: response.status });
}

function extractErrorMessage(bodyText: string): string | undefined {
  if (!bodyText) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { message?: string; code?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") {
      return parsed.error;
    }
    if (parsed.error && typeof parsed.error === "object") {
      return parsed.error.message ?? parsed.error.code;
    }
    if (typeof parsed.message === "string") {
      return parsed.message;
    }
  } catch {
    const trimmed = bodyText.trim();
    if (trimmed && trimmed.length < 300 && !trimmed.startsWith("<")) {
      return trimmed;
    }
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** attempt;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof error === "object" && error !== null && "name" in error && (error as { name: string }).name === "AbortError")
  );
}
