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

  it("lists recent entries matching a query or key prefix", async () => {
    const cache = new MemoryCacheStore();
    await cache.set("food-log:v1:query:banana", { query: "banana", description: "banana" }, 60_000);
    await cache.set("food-log:v1:query:banana bread", { query: "Banana bread", description: "bread" }, 60_000);
    await cache.set("food-log:v1:query:oatmeal", { query: "oatmeal", description: "oats" }, 60_000);

    const prefixed = await cache.listRecent({ queryPrefix: "ban", keyPrefix: "food-log:v1:query:ban", limit: 8 });
    expect(prefixed.map((entry) => (entry.value as { query: string }).query)).toEqual(["Banana bread", "banana"]);

    const recent = await cache.listRecent({ limit: 2 });
    expect(recent).toHaveLength(2);
    expect((recent[0]?.value as { query: string }).query).toBe("oatmeal");
  });
});
