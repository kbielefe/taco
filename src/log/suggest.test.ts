import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../fdc/cache.js";
import { FoodLogger } from "./logger.js";
import { MemoryFoodStore } from "./store.js";
import type { FdcLookup, FoodLogAi, FoodLogMacros } from "./types.js";

const macros: FoodLogMacros = { caloriesKcal: 10, proteinG: 1, fatG: 1, carbG: 1, fiberG: 1 };

function loggerWith(cache: MemoryCacheStore): FoodLogger {
  const fdc: FdcLookup = {
    searchFoods: async () => ({ foods: [] }),
    getFood: async () => {
      throw new Error("unused");
    },
  };
  const ai: FoodLogAi = {
    parseQuery: async () => ({ items: [] }),
    selectMatch: async () => {
      throw new Error("unused");
    },
  };
  return new FoodLogger({ fdc, ai, queryCache: cache, foodStore: new MemoryFoodStore() });
}

async function remember(cache: MemoryCacheStore, query: string, description = query): Promise<void> {
  await cache.set(
    `food-log:v1:query:${query.trim().toLowerCase()}`,
    { query, description, macros, items: [] },
    60_000,
  );
}

describe("FoodLogger.suggest", () => {
  it("fuzzy-matches, then sorts the closest hit first and breaks ties by recency", async () => {
    const cache = new MemoryCacheStore();
    await remember(cache, "banana", "Bananas, raw");
    await remember(cache, "Banana bread", "Bread");
    await remember(cache, "Cheerios and milk", "Cheerios");
    await remember(cache, "oatmeal", "Rolled oats");
    await cache.set("fdc:v1:food:1:full", { query: "banana split", description: "split", macros, items: [] }, 60_000);
    const logger = loggerWith(cache);

    expect((await logger.suggest("bread")).map((item) => item.query)).toEqual(["Banana bread"]);
    expect((await logger.suggest("milk")).map((item) => item.query)).toEqual(["Cheerios and milk"]);
    expect((await logger.suggest("nana")).map((item) => item.query)).toEqual(["banana", "Banana bread"]);
    expect((await logger.suggest("oats")).map((item) => item.query)).toEqual(["oatmeal"]);
    expect((await logger.suggest("a", 2)).map((item) => item.query)).toEqual(["banana", "oatmeal"]);
    expect((await logger.suggest("")).map((item) => item.query)).toEqual([
      "oatmeal",
      "Cheerios and milk",
      "Banana bread",
      "banana",
    ]);
    expect(await logger.suggest("zz")).toEqual([]);
  });
});

describe("FoodLogger.forgetSuggestion", () => {
  it("removes a cached query so it no longer suggests", async () => {
    const cache = new MemoryCacheStore();
    await remember(cache, "banana", "Bananas, raw");
    await remember(cache, "Banana bread", "Bread");
    const logger = loggerWith(cache);

    expect(await logger.forgetSuggestion("banana")).toBe(true);
    expect((await logger.suggest("ban")).map((item) => item.query)).toEqual(["Banana bread"]);
    expect(await logger.forgetSuggestion("banana")).toBe(false);
    expect(await logger.forgetSuggestion("   ")).toBe(false);
  });
});
