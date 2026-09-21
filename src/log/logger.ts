import { MongoClient } from "mongodb";
import { MongoCacheStore, type CacheStore } from "../fdc/cache.js";
import { FdcClient } from "../fdc/client.js";
import type { FoodItem, SearchResultFood } from "../fdc/types.js";
import { XaiFoodLogAi } from "./ai.js";
import { FoodLogAiError, FoodLogConfigError, FoodLogMatchError } from "./errors.js";
import { candidateIds, clampGrams, compactSearchCandidate } from "./match.js";
import { macrosForGrams, sumMacros, tryMacrosForGrams, withSearchNutrients } from "./nutrients.js";
import { cacheResolution, QUERY_CACHE_PREFIX, queryCacheKey, suggestionFromCacheEntry, normalizeQuery } from "./query-cache.js";
import { MongoFoodStore } from "./store.js";
import {
  CACHE_COLLECTION,
  FOOD_LOG_CACHE_SOURCE,
  HEALTH_DB,
  QUERY_CACHE_TTL_MS,
  SUGGEST_LIMIT,
  type FdcLookup,
  type FoodLogAi,
  type FoodLogEntry,
  type FoodLogItem,
  type FoodLogResolution,
  type FoodLogSuggestion,
  type FoodStore,
  type LogFoodOptions,
  type ParsedFoodItem,
} from "./types.js";

const SEARCH_PAGE_SIZE = 8;

export interface FoodLoggerOptions {
  fdc: FdcLookup;
  ai: FoodLogAi;
  queryCache: CacheStore;
  foodStore: FoodStore;
  mongo?: MongoClient;
  ownsMongo?: boolean;
}

export interface CreateFoodLoggerOptions {
  fdc?: FdcLookup;
  ai?: FoodLogAi;
  queryCache?: CacheStore;
  foodStore?: FoodStore;
  mongoUri?: string;
  xaiApiKey?: string;
  usdaApiKey?: string;
  model?: string;
  fdcCache?: CacheStore;
}

export class FoodLogger {
  private readonly fdc: FdcLookup;
  private readonly ai: FoodLogAi;
  private readonly queryCache: CacheStore;
  private readonly foodStore: FoodStore;
  private readonly mongo?: MongoClient;
  private readonly ownsMongo: boolean;
  private readonly inflight = new Map<string, Promise<FoodLogResolution>>();

  constructor(options: FoodLoggerOptions) {
    this.fdc = options.fdc;
    this.ai = options.ai;
    this.queryCache = options.queryCache;
    this.foodStore = options.foodStore;
    this.mongo = options.mongo;
    this.ownsMongo = options.ownsMongo ?? false;
  }

  async log(query: string, options: LogFoodOptions = {}): Promise<FoodLogEntry> {
    const trimmed = query.trim();
    if (trimmed === "") {
      throw new FoodLogConfigError("food log query is required");
    }
    const resolution = await this.resolve(trimmed, options.skipCache === true);
    const now = new Date();
    return this.foodStore.insert({
      eatenAt: options.eatenAt ?? now,
      query: trimmed,
      description: resolution.description,
      macros: resolution.macros,
      items: resolution.items,
      createdAt: now,
    });
  }

  async list(from: Date, to: Date): Promise<FoodLogEntry[]> {
    return this.foodStore.listByEatenAt(from, to);
  }

  async delete(id: string): Promise<boolean> {
    return this.foodStore.deleteById(id);
  }

  async suggest(prefix: string, limit = SUGGEST_LIMIT): Promise<FoodLogSuggestion[]> {
    const normalized = normalizeQuery(prefix);
    const entries = await this.queryCache.listRecent({
      queryPrefix: normalized || undefined,
      keyPrefix: normalized ? `${QUERY_CACHE_PREFIX}${normalized}` : undefined,
      limit: Math.max(limit * 2, SUGGEST_LIMIT),
    });
    const suggestions: FoodLogSuggestion[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      const suggestion = suggestionFromCacheEntry(entry);
      if (!suggestion) {
        continue;
      }
      const key = normalizeQuery(suggestion.query);
      if (normalized && !key.startsWith(normalized)) {
        continue;
      }
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      suggestions.push(suggestion);
      if (suggestions.length >= limit) {
        break;
      }
    }
    return suggestions;
  }

  async close(): Promise<void> {
    if (this.ownsMongo) {
      await this.mongo?.close();
    }
  }

  private async resolve(query: string, skipCache: boolean): Promise<FoodLogResolution> {
    const key = queryCacheKey(query);
    if (!skipCache) {
      const cached = await this.queryCache.get<FoodLogResolution>(key);
      if (cached) {
        return cached;
      }
      const existing = this.inflight.get(key);
      if (existing) {
        return existing;
      }
    }

    const pending = this.resolveFresh(query)
      .then(async (value) => {
        await this.queryCache.set(key, cacheResolution(query, value), QUERY_CACHE_TTL_MS);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    if (!skipCache) {
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async resolveFresh(query: string): Promise<FoodLogResolution> {
    const parsed = await this.ai.parseQuery(query);
    if (parsed.items.length === 0) {
      throw new FoodLogAiError("Model returned no food items");
    }
    const items = await Promise.all(parsed.items.map((item) => this.resolveItem(query, item)));
    return {
      description: items.map((item) => `${item.name} (${item.servingDescription})`).join(" and "),
      macros: sumMacros(items.map((item) => item.macros)),
      items,
    };
  }

  private async resolveItem(mealQuery: string, item: ParsedFoodItem): Promise<FoodLogItem> {
    const foods = await this.searchItem(item);
    if (foods.length === 0) {
      throw new FoodLogMatchError(`No FDC match for "${item.name}"`, {
        query: item.searchQuery,
        candidates: [],
      });
    }

    const candidates = foods.map((food) => compactSearchCandidate(food, item.quantity));
    const selected = await this.ai.selectMatch({ mealQuery, item, candidates });
    if (!candidateIds(candidates).has(selected.fdcId)) {
      throw new FoodLogAiError(
        `Model selected FDC ${selected.fdcId} which was not in the candidate list for "${item.name}"`,
      );
    }

    const food = await this.fdc.getFood(selected.fdcId);
    const grams = clampGrams(selected.grams);
    const searchHit = foods.find((candidate) => candidate.fdcId === food.fdcId);
    const macros = await this.macrosForItem(food, grams, searchHit);
    return {
      name: item.name,
      fdcId: food.fdcId,
      description: food.description,
      dataType: food.dataType,
      grams,
      servingDescription: selected.servingDescription,
      macros,
    };
  }

  private async macrosForItem(food: FoodItem, grams: number, searchHit?: SearchResultFood) {
    const fromDetail = tryMacrosForGrams(food, grams);
    if (fromDetail) {
      return fromDetail;
    }
    if (searchHit) {
      const fromSearch = tryMacrosForGrams(withSearchNutrients(food, searchHit), grams);
      if (fromSearch) {
        return fromSearch;
      }
    }
    const abridged = await this.fdc.getFood(food.fdcId, { format: "abridged" });
    return macrosForGrams({ ...food, foodNutrients: abridged.foodNutrients }, grams);
  }

  private async searchItem(item: ParsedFoodItem) {
    const primary = await this.fdc.searchFoods({
      query: item.searchQuery,
      brandOwner: item.brandOwner,
      dataType: item.dataTypes,
      pageSize: SEARCH_PAGE_SIZE,
    });
    const foods = [...(primary.foods ?? [])];
    if (!item.fallbackQuery) {
      return foods;
    }
    const fallback = await this.fdc.searchFoods({
      query: item.fallbackQuery,
      pageSize: SEARCH_PAGE_SIZE,
    });
    const seen = new Set(foods.map((food) => food.fdcId));
    for (const food of fallback.foods ?? []) {
      if (!seen.has(food.fdcId)) {
        seen.add(food.fdcId);
        foods.push(food);
      }
    }
    return foods;
  }
}

export async function createFoodLogger(options: CreateFoodLoggerOptions = {}): Promise<FoodLogger> {
  const ai =
    options.ai ??
    new XaiFoodLogAi({
      apiKey: options.xaiApiKey,
      model: options.model,
    });

  let fdc = options.fdc;
  let queryCache = options.queryCache;
  let foodStore = options.foodStore;
  let mongo: MongoClient | undefined;
  let ownsMongo = false;

  if (!fdc || !queryCache || !foodStore) {
    const uri = options.mongoUri ?? process.env.MONGODB_URI;
    if (!uri) {
      throw new FoodLogConfigError("MONGODB_URI is not set");
    }
    mongo = new MongoClient(uri);
    await mongo.connect();
    ownsMongo = true;
    try {
      const db = mongo.db(HEALTH_DB);
      queryCache ??= await MongoCacheStore.connect(db, CACHE_COLLECTION, FOOD_LOG_CACHE_SOURCE);
      foodStore ??= await MongoFoodStore.connect(db);
      if (!fdc) {
        const usdaApiKey = options.usdaApiKey ?? process.env.USDA_API_KEY;
        if (!usdaApiKey) {
          throw new FoodLogConfigError("USDA_API_KEY is not set");
        }
        const fdcCache = options.fdcCache ?? (await MongoCacheStore.connect(db, CACHE_COLLECTION));
        fdc = new FdcClient({ apiKey: usdaApiKey, cache: fdcCache });
      }
    } catch (error) {
      await mongo.close();
      throw error;
    }
  }

  return new FoodLogger({
    fdc,
    ai,
    queryCache,
    foodStore,
    mongo,
    ownsMongo,
  });
}
