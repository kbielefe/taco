import { describe, expect, it } from "vitest";
import { MemoryCacheStore, foodCacheKey, searchCacheKey } from "./cache.js";

describe("cache keys", () => {
  it("normalizes nutrient order", () => {
    expect(foodCacheKey(1, "full", [204, 203])).toBe(foodCacheKey(1, "full", [203, 204]));
  });

  it("treats equivalent search criteria as the same key", () => {
    expect(searchCacheKey({ query: "apple", pageSize: 10 })).toBe(
      searchCacheKey({ pageSize: 10, query: "apple" }),
    );
  });
});

describe("MemoryCacheStore", () => {
  it("expires entries after ttl", async () => {
    const cache = new MemoryCacheStore();
    await cache.set("k", { ok: true }, 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await cache.get("k")).toBeUndefined();
  });
});
