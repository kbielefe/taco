import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../fdc/cache.js";
import type { FoodItem, SearchResult, SearchResultFood } from "../fdc/types.js";
import { FoodLogger } from "../log/logger.js";
import { MemoryFoodStore } from "../log/store.js";
import type { FoodLogAi, ParsedMeal, SelectMatchInput, SelectedMatch } from "../log/types.js";
import { createApp } from "./routes.js";

function jsonFood(overrides: Partial<SearchResultFood> & Pick<SearchResultFood, "fdcId" | "description">): SearchResultFood {
  return { dataType: "SR Legacy", score: 100, ...overrides };
}

function details(fdcId: number, description: string, calories: number): FoodItem {
  return {
    fdcId,
    dataType: "SR Legacy",
    description,
    foodNutrients: [
      { amount: calories, nutrient: { id: 1008, number: "208", name: "Energy", unitName: "KCAL" } },
      { amount: 1, nutrient: { id: 1003, number: "203", name: "Protein", unitName: "G" } },
      { amount: 1, nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "G" } },
      { amount: 10, nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "G" } },
      { amount: 1, nutrient: { id: 1079, number: "291", name: "Fiber, total dietary", unitName: "G" } },
    ],
  };
}

function mockAi(parsed: ParsedMeal, match: SelectedMatch): FoodLogAi {
  return {
    parseQuery: vi.fn(async () => parsed),
    selectMatch: vi.fn(async (_input: SelectMatchInput) => match),
  };
}

function testApp() {
  const foodStore = new MemoryFoodStore();
  const queryCache = new MemoryCacheStore();
  const logger = new FoodLogger({
    fdc: {
      searchFoods: vi.fn(async () => ({ foods: [jsonFood({ fdcId: 1, description: "Bananas, raw" })] }) satisfies SearchResult),
      getFood: vi.fn(async () => details(1, "Bananas, raw", 89)),
    },
    ai: mockAi(
      { items: [{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }] },
      { fdcId: 1, grams: 118, servingDescription: "1 banana" },
    ),
    queryCache,
    foodStore,
  });
  return { app: createApp(logger), logger, foodStore };
}

describe("food log HTTP API", () => {
  it("reports health", async () => {
    const { app } = testApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("logs a meal, lists it in range, and returns totals", async () => {
    const { app } = testApp();
    const created = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana", eatenAt: "2026-09-20T12:00:00.000Z" }),
    });
    expect(created.status).toBe(201);
    const meal = await created.json();
    expect(meal.query).toBe("banana");
    expect(meal.macros.caloriesKcal).toBeGreaterThan(0);

    const listed = await app.request("/api/meals?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z");
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.meals).toHaveLength(1);
    expect(body.totals.caloriesKcal).toBe(meal.macros.caloriesKcal);
  });

  it("rejects an empty query", async () => {
    const { app } = testApp();
    const res = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "  " }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: "Enter what you ate" } });
  });

  it("returns 422 when no FDC match is found", async () => {
    const logger = new FoodLogger({
      fdc: {
        searchFoods: vi.fn(async () => ({ foods: [] })),
        getFood: vi.fn(async () => details(1, "x", 1)),
      },
      ai: mockAi({ items: [{ name: "mystery", searchQueries: ["mystery"], servingHint: "1 bowl", quantity: 1 }] }, {
        fdcId: 1,
        grams: 100,
        servingDescription: "1 bowl",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    const app = createApp(logger);
    const res = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "mystery stew" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.message).toMatch(/simpler description/i);
  });

  it("deletes a meal and 404s when it is already gone", async () => {
    const { app } = testApp();
    const created = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana", eatenAt: "2026-09-20T12:00:00.000Z" }),
    });
    const meal = await created.json();
    const deleted = await app.request(`/api/meals/${meal.id}`, { method: "DELETE" });
    expect(deleted.status).toBe(204);
    const again = await app.request(`/api/meals/${meal.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("suggests cached queries", async () => {
    const { app } = testApp();
    await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana" }),
    });
    const res = await app.request("/api/suggestions?q=ban");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.suggestions[0]?.query).toBe("banana");
  });

  it("requires from and to when listing meals", async () => {
    const { app } = testApp();
    const res = await app.request("/api/meals");
    expect(res.status).toBe(400);
  });

  it("streams progress lines then the meal as NDJSON", async () => {
    const { app } = testApp();
    const res = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ query: "banana" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/ndjson/);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: string; meal?: { query: string } });
    expect(events.map((event) => event.type)).toEqual([
      "progress",
      "progress",
      "progress",
      "progress",
      "progress",
      "result",
    ]);
    expect(events[1]).toEqual({ type: "progress", message: "Running 1 FDC search." });
    expect(events.at(-1)).toMatchObject({ type: "result", meal: { query: "banana" } });
  });

  it("streams a match error as an NDJSON error event", async () => {
    const logger = new FoodLogger({
      fdc: {
        searchFoods: vi.fn(async () => ({ foods: [] })),
        getFood: vi.fn(async () => details(1, "x", 1)),
      },
      ai: mockAi({ items: [{ name: "mystery", searchQueries: ["mystery"], servingHint: "1 bowl", quantity: 1 }] }, {
        fdcId: 1,
        grams: 100,
        servingDescription: "1 bowl",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    const app = createApp(logger);
    const res = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ query: "mystery stew" }),
    });
    expect(res.status).toBe(200);
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; status?: number; error?: { message: string } });
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.status).toBe(422);
    expect(last?.error?.message).toMatch(/simpler description/i);
  });
});
