import { describe, expect, it, vi } from "vitest";
import { FdcClient } from "./client.js";
import { MemoryCacheStore } from "./cache.js";
import { FdcBadRequestError, FdcNotFoundError, FdcRateLimitError, FdcServerError } from "./errors.js";
import { HourlyRateLimiter } from "./rate-limit.js";
import type { FoodItem, SearchResult } from "./types.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function broccoli(): FoodItem {
  return { fdcId: 170379, dataType: "SR Legacy", description: "Broccoli, raw" };
}

function cheddar(): FoodItem {
  return { fdcId: 2057648, dataType: "Branded", description: "CHEDDAR CHEESE" };
}

describe("FdcClient", () => {
  it("reads USDA food details and caches the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(broccoli(), 200, { "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "999" }),
    );
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    const first = await client.getFood(170379);
    const second = await client.getFood(170379);

    expect(first.description).toBe("Broccoli, raw");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe("/fdc/v1/food/170379");
    expect(requested.searchParams.get("api_key")).toBe("test-key");
  });

  it("coalesces in-flight requests for the same food", async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    const pending = Promise.all([client.getFood(170379), client.getFood(170379)]);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    resolveFetch?.(jsonResponse(broccoli()));
    const [a, b] = await pending;
    expect(a).toEqual(b);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("only fetches uncached ids when loading a batch", async () => {
    const cache = new MemoryCacheStore();
    await cache.set("fdc:v1:food:170379:full", broccoli(), 60_000);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse([cheddar()]));
    const client = new FdcClient({ apiKey: "test-key", cache, fetch: fetchMock });

    const foods = await client.getFoods([170379, 2057648]);
    expect(foods.map((food) => food.fdcId)).toEqual([170379, 2057648]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toMatchObject({ fdcIds: [2057648], format: "full" });
  });

  it("throws FdcNotFoundError for a missing food and serves later lookups from cache", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("no results found", { status: 404 }))
      .mockResolvedValueOnce(jsonResponse(broccoli()));
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    await expect(client.getFood(1)).rejects.toBeInstanceOf(FdcNotFoundError);
    await expect(client.getFood(1)).rejects.toBeInstanceOf(FdcNotFoundError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps HTTP 429 to FdcRateLimitError and blocks further calls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "OVER_RATE_LIMIT", message: "Too Many Requests" } }), {
        status: 429,
        headers: { "Retry-After": "3600", "Content-Type": "application/json" },
      }),
    );
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    await expect(client.searchFoods({ query: "apple" })).rejects.toBeInstanceOf(FdcRateLimitError);
    await expect(client.searchFoods({ query: "apple" })).rejects.toBeInstanceOf(FdcRateLimitError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries 5xx responses then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ totalHits: 1, foods: [] } satisfies SearchResult));
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    const result = await client.searchFoods({ query: "apple" });
    expect(result.totalHits).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after repeated 5xx responses", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response("unavailable", { status: 503 })));
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    await expect(client.listFoods({ pageSize: 1 })).rejects.toBeInstanceOf(FdcServerError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid page sizes before calling the API", async () => {
    const fetchMock = vi.fn();
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
    });

    await expect(client.searchFoods({ query: "x", pageSize: 201 })).rejects.toBeInstanceOf(
      FdcBadRequestError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops before sending a request that would exceed the local hourly budget", async () => {
    const fetchMock = vi.fn();
    const client = new FdcClient({
      apiKey: "test-key",
      cache: new MemoryCacheStore(),
      fetch: fetchMock,
      rateLimiter: new HourlyRateLimiter(1, 1),
    });

    await expect(client.getFood(170379)).rejects.toBeInstanceOf(FdcRateLimitError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
