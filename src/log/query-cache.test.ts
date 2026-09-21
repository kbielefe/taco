import { describe, expect, it } from "vitest";
import { normalizeQuery, queryCacheKey } from "./query-cache.js";

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
  });
});
