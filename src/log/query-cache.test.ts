import { describe, expect, it } from "vitest";
import { cacheResolution, normalizeQuery, queryCacheKey, queryFromCacheKey, suggestionFromCacheEntry } from "./query-cache.js";

describe("queryCacheKey", () => {
  it("normalizes case and whitespace", () => {
    expect(normalizeQuery("  Cheerios   and Milk ")).toBe("cheerios and milk");
    expect(queryCacheKey("Cheerios and milk")).toBe(queryCacheKey("  cheerios   AND   MILK "));
  });

  it("hashes very long queries", () => {
    const long = "banana ".repeat(300);
    const key = queryCacheKey(long);
    expect(key.startsWith("food-log:v1:query:")).toBe(true);
    expect(key.length).toBeLessThan(1024);
    expect(queryFromCacheKey(key)).toBeUndefined();
  });

  it("recovers the query from an unhashed key", () => {
    expect(queryFromCacheKey(queryCacheKey("Cheerios and milk"))).toBe("cheerios and milk");
  });

  it("builds a suggestion from a cached value", () => {
    const resolution = {
      description: "banana (1 medium)",
      macros: { caloriesKcal: 105, proteinG: 1.3, fatG: 0.4, carbG: 27, fiberG: 3.1 },
      items: [],
    };
    const cached = cacheResolution("Banana", resolution);
    const suggestion = suggestionFromCacheEntry({
      key: queryCacheKey("Banana"),
      value: cached,
      createdAt: new Date(),
    });
    expect(suggestion).toEqual({
      query: "Banana",
      description: "banana (1 medium)",
      macros: resolution.macros,
    });
  });
});
