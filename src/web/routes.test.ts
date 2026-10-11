import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { createCorrectionRunner, type CorrectionRunner } from "../correct/run.js";
import { correctedMacros, fitEnergyWindows, type CorrectionFit } from "../correct/fit.js";
import { MemoryCacheStore } from "../fdc/cache.js";
import { FdcNetworkError, FdcRateLimitError, FdcServerError, FdcTimeoutError } from "../fdc/errors.js";
import type { FoodItem, SearchResult, SearchResultFood } from "../fdc/types.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import { FoodLogger } from "../log/logger.js";
import { sumMacros } from "../log/nutrients.js";
import { MemoryFoodStore } from "../log/store.js";
import type { FoodLogAi, FoodLogEntry, ParsedMeal, SelectMatchInput, SelectedMatch } from "../log/types.js";
import { MemoryCorrectionStore } from "../correct/store.js";
import { createApp } from "./routes.js";
import { serializeMeal } from "./serialize.js";
import { createSyncHub } from "./sync.js";

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

function testApp(options: { corrections?: CorrectionRunner; sync?: ReturnType<typeof createSyncHub> } = {}) {
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
  return {
    app: createApp({
      logger,
      journal: new Journal(new MemoryJournalStore()),
      corrections: options.corrections,
      sync: options.sync,
    }),
    logger,
    foodStore,
  };
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
    expect(meal).not.toHaveProperty("adjusted");

    const listed = await app.request("/api/meals?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z");
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(body.meals).toHaveLength(1);
    expect(body.totals.caloriesKcal).toBe(meal.macros.caloriesKcal);
    expect(body).not.toHaveProperty("correctionPending");
    expect(body.meals[0]).not.toHaveProperty("adjusted");
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
    const app = createApp({ logger, journal: new Journal(new MemoryJournalStore()) });
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

  it("notifies open browsers when a meal or journal entry changes", async () => {
    const topics: string[] = [];
    const sync = createSyncHub();
    sync.subscribe((topic) => {
      topics.push(topic);
    });
    const { app } = testApp({ sync });
    const created = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana", eatenAt: "2026-09-20T12:00:00.000Z" }),
    });
    const meal = (await created.json()) as { id: string };
    await app.request(`/api/meals/${meal.id}`, { method: "DELETE" });
    const noted = await app.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: { label: "Nurtec", fields: [{ label: "Taken", type: "event" }] },
        values: [{ fieldId: "Taken", value: true }],
      }),
    });
    const entry = (await noted.json()) as { id: string; kind: { id: string } };
    await app.request(`/api/journal/kinds/${entry.kind.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addFields: [{ label: "Note", type: "text" }] }),
    });
    await app.request(`/api/journal/${entry.id}`, { method: "DELETE" });
    expect(topics).toEqual(["food", "food", "journal", "journal", "journal"]);

    const events = await app.request("/api/events");
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    await events.body?.cancel();
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
    const app = createApp({ logger, journal: new Journal(new MemoryJournalStore()) });
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

  it.each([
    ["network", new FdcNetworkError("Failed to reach the USDA FDC API")],
    ["timeout", new FdcTimeoutError("USDA FDC request timed out after 10000ms")],
    ["server", new FdcServerError("USDA FDC returned 503", { status: 503 })],
    ["rate limit", new FdcRateLimitError("USDA FDC rate limit exceeded", 60_000)],
  ])("tells the user when the USDA database has a temporary %s failure", async (_label, failure) => {
    const logger = new FoodLogger({
      fdc: {
        searchFoods: vi.fn(async () => {
          throw failure;
        }),
        getFood: vi.fn(async () => details(1, "x", 1)),
      },
      ai: mockAi({ items: [{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }] }, {
        fdcId: 1,
        grams: 118,
        servingDescription: "1 banana",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    const app = createApp({ logger, journal: new Journal(new MemoryJournalStore()) });
    const message = "The USDA food database is temporarily unavailable. Try again in a moment.";

    const json = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana" }),
    });
    expect(json.status).toBe(503);
    expect(await json.json()).toEqual({ error: { message } });

    const streamed = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ query: "banana" }),
    });
    expect(streamed.status).toBe(200);
    const events = (await streamed.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; status?: number; error?: { message: string } });
    expect(events.at(-1)).toEqual({ type: "error", error: { message }, status: 503 });
  });
});

describe("journal HTTP API", () => {
  function app() {
    return createApp({
      logger: new FoodLogger({
        fdc: {
          searchFoods: vi.fn(async () => ({ foods: [] })),
          getFood: vi.fn(async () => details(1, "x", 1)),
        },
        ai: mockAi({ items: [] }, { fdcId: 1, grams: 1, servingDescription: "x" }),
        queryCache: new MemoryCacheStore(),
        foodStore: new MemoryFoodStore(),
      }),
      journal: new Journal(new MemoryJournalStore()),
    });
  }

  it("creates a kind with its first entry, lists it, and deletes it", async () => {
    const api = app();
    const created = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        at: "2026-09-20T15:00:00.000Z",
        kind: { label: "Weight", fields: [{ label: "Weight", type: "number", unit: "lb" }] },
        values: [{ fieldId: "Weight", value: 315 }],
      }),
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { id: string; values: { value: number }[]; kind: { label: string } };
    expect(entry.kind.label).toBe("Weight");
    expect(entry.values[0]?.value).toBe(315);

    const listed = await api.request("/api/journal?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z");
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { observations: { id: string }[] };
    expect(body.observations.map((item) => item.id)).toEqual([entry.id]);

    const removed = await api.request(`/api/journal/${entry.id}`, { method: "DELETE" });
    expect(removed.status).toBe(204);
    const missing = await api.request(`/api/journal/${entry.id}`, { method: "DELETE" });
    expect(missing.status).toBe(404);
  });

  it("rejects a duplicate name, a bad choice, and an event that did not happen", async () => {
    const api = app();
    const first = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: { label: "Migraine", fields: [{ label: "Course", type: "enum", options: ["started", "gone"] }] },
        values: [{ fieldId: "Course", value: "gone" }],
      }),
    });
    expect(first.status).toBe(201);

    const duplicate = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: { label: "migraine", fields: [{ label: "Course", type: "enum", options: ["started", "gone"] }] },
        values: [{ fieldId: "Course", value: "started" }],
      }),
    });
    expect(duplicate.status).toBe(409);

    const migraine = (await first.json()) as { kind: { id: string } };
    const bad = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kindId: migraine.kind.id, values: [{ fieldId: "course", value: "awful" }] }),
    });
    expect(bad.status).toBe(400);

    const event = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: { label: "Nurtec", fields: [{ label: "Taken", type: "event" }] },
        values: [{ fieldId: "Taken", value: false }],
      }),
    });
    expect(event.status).toBe(400);
  });

  it("appends a field onto an existing kind", async () => {
    const api = app();
    const created = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: {
          label: "Blood pressure",
          fields: [
            { label: "Systolic", type: "number", unit: "mmHg" },
            { label: "Diastolic", type: "number", unit: "mmHg" },
          ],
        },
        values: [
          { fieldId: "Systolic", value: 120 },
          { fieldId: "Diastolic", value: 80 },
        ],
      }),
    });
    expect(created.status).toBe(201);
    const entry = (await created.json()) as { kind: { id: string } };
    const appended = await api.request(`/api/journal/kinds/${entry.kind.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ addFields: [{ label: "Arm", type: "text" }] }),
    });
    expect(appended.status).toBe(200);
    const kind = (await appended.json()) as { fields: { id: string }[]; suggestions: Record<string, string[]> };
    expect(kind.fields.map((field) => field.id)).toEqual(["systolic", "diastolic", "arm"]);

    const kinds = await api.request("/api/journal/kinds");
    const listed = (await kinds.json()) as {
      kinds: { recentValues: Record<string, { fieldId: string; value: number }[]> }[];
    };
    expect(listed.kinds[0]?.recentValues["n:120"]).toEqual([{ fieldId: "diastolic", value: 80 }]);
  });
});

describe("calorie recommendation", () => {
  function app(env: NodeJS.ProcessEnv = {}) {
    return createApp({
      logger: new FoodLogger({
        fdc: {
          searchFoods: vi.fn(async () => ({ foods: [] })),
          getFood: vi.fn(async () => details(1, "x", 1)),
        },
        ai: mockAi({ items: [] }, { fdcId: 1, grams: 1, servingDescription: "x" }),
        queryCache: new MemoryCacheStore(),
        foodStore: new MemoryFoodStore(),
      }),
      journal: new Journal(new MemoryJournalStore()),
      env,
    });
  }

  it("requires today", async () => {
    const res = await app().request("/api/recommendation");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { message: "today is a required ISO date" } });
  });

  it("asks for the body profile when .env does not have it", async () => {
    const res = await app().request("/api/recommendation?today=2026-09-21T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kcal: number | null; message: string };
    expect(body.kcal).toBeNull();
    expect(body.message).toBe("Set BIRTH_YEAR, SEX, and HEIGHT_IN or HEIGHT_CM in .env.");
  });

  it("asks for a weight once the profile is set", async () => {
    const res = await app({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70" }).request(
      "/api/recommendation?today=2026-09-21T00:00:00.000Z",
    );
    const body = (await res.json()) as { kcal: number | null; message: string };
    expect(body.kcal).toBeNull();
    expect(body.message).toMatch(/Log a weight/);
  });

  it("recommends from a weight logged in pounds", async () => {
    const api = app({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70" });
    const created = await api.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        at: "2026-09-20T15:00:00.000Z",
        kind: { label: "weight", fields: [{ label: "weight", type: "number", unit: "pounds" }] },
        values: [{ fieldId: "weight", value: 313 }],
      }),
    });
    expect(created.status).toBe(201);

    const res = await api.request("/api/recommendation?today=2026-09-21T00:00:00.000Z");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kcal: number; minKcal: number; maxKcal: number; goal: string; basis: string };
    expect(body.kcal).toBe(1770);
    expect(body.minKcal).toBe(1500);
    expect(body.maxKcal).toBe(2040);
    expect(body.goal).toBe("lose");
    expect(body.basis).toBe("body");
  });
});

describe("calorie correction", () => {
  const env = { BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70" };

  function weightBody(timeZone = "UTC"): string {
    return JSON.stringify({
      at: "2026-09-20T15:00:00.000Z",
      timeZone,
      kind: { label: "weight", fields: [{ label: "weight", type: "number", unit: "kg" }] },
      values: [{ fieldId: "weight", value: 80 }],
    });
  }

  it("returns a weigh-in before the fit starts and marks the list pending", async () => {
    let started = false;
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new MemoryCorrectionStore();
    const corrections = createCorrectionRunner({
      store,
      env,
      load: async () => {
        started = true;
        await gate;
        return { meals: [], observations: [] };
      },
    });
    const { app } = testApp({ corrections });
    try {
      const created = await app.request("/api/journal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: weightBody(),
      });
      expect(created.status).toBe(201);
      expect(started).toBe(false);
      expect(corrections.pending()).toBe(true);
      const listed = await app.request("/api/meals?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z");
      const body = (await listed.json()) as { correctionPending?: boolean };
      expect(body.correctionPending).toBe(true);
    } finally {
      release();
      await corrections.whenIdle();
    }
    const saved = await store.read();
    expect(saved?.timeZone).toBe("UTC");
    expect(saved?.fit.fitted).toBe(false);
  });

  it("fits a weigh-in again when it is deleted, and ignores other entries", async () => {
    let runs = 0;
    const corrections = createCorrectionRunner({
      store: new MemoryCorrectionStore(),
      env,
      load: async () => {
        runs += 1;
        return { meals: [], observations: [] };
      },
    });
    const { app } = testApp({ corrections });
    const weight = await app.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: weightBody(),
    });
    const weightId = ((await weight.json()) as { id: string }).id;
    await corrections.whenIdle();
    expect(runs).toBe(1);

    const migraine = await app.request("/api/journal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: { label: "Migraine", fields: [{ label: "Course", type: "enum", options: ["started", "gone"] }] },
        values: [{ fieldId: "Course", value: "gone" }],
      }),
    });
    expect(migraine.status).toBe(201);
    const migraineId = ((await migraine.json()) as { id: string }).id;
    await corrections.whenIdle();
    expect(runs).toBe(1);

    const removedNote = await app.request(`/api/journal/${migraineId}?timeZone=UTC`, { method: "DELETE" });
    expect(removedNote.status).toBe(204);
    await corrections.whenIdle();
    expect(runs).toBe(1);

    const removedWeight = await app.request(`/api/journal/${weightId}?timeZone=UTC`, { method: "DELETE" });
    expect(removedWeight.status).toBe(204);
    await corrections.whenIdle();
    expect(runs).toBe(2);
  });

  it("applies a stored fit on the logged meal and the list, and keeps logged totals", async () => {
    const fit = fitEnergyWindows([]);
    fit.expenditureFactor = 2;
    fit.foods = [
      {
        id: "discrete\tbanana",
        key: "banana",
        category: "discrete",
        delta: 0,
        factor: 1.1,
        low: 1.05,
        high: 1.2,
        applied: 1.1,
        excludesOne: true,
      },
    ];
    const corrections: CorrectionRunner = {
      schedule() {},
      current: async () => fit,
      pending: () => false,
      whenIdle: async () => {},
      close: async () => {},
    };
    const { app } = testApp({ corrections });
    const created = await app.request("/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "banana", eatenAt: "2026-09-20T12:00:00.000Z" }),
    });
    expect(created.status).toBe(201);
    const meal = (await created.json()) as {
      macros: { caloriesKcal: number };
      adjusted: { caloriesKcal: number };
      items: { name: string; dataType: string; grams: number; servingDescription: string; macros: FoodLogEntry["items"][number]["macros"]; correction: { factor: number; label: string } }[];
    };
    const item = meal.items[0];
    expect(item?.correction).toEqual({ factor: 1.1, label: "its own factor" });
    expect(item).toBeDefined();
    if (!item) {
      return;
    }
    const adjusted = sumMacros([
      correctedMacros(
        { name: item.name, dataType: item.dataType, grams: item.grams, servingDescription: item.servingDescription, macros: item.macros },
        fit,
      ),
    ]);
    expect(meal.adjusted).toEqual(adjusted);
    expect(meal.adjusted.caloriesKcal).not.toBe(meal.macros.caloriesKcal);

    const listed = await app.request("/api/meals?from=2026-09-20T00:00:00.000Z&to=2026-09-21T00:00:00.000Z");
    const body = (await listed.json()) as { meals: { adjusted: { caloriesKcal: number } }[]; totals: { caloriesKcal: number }; correctionPending?: boolean };
    expect(body.meals[0]?.adjusted.caloriesKcal).toBe(meal.adjusted.caloriesKcal);
    expect(body.totals.caloriesKcal).toBe(meal.macros.caloriesKcal);
    expect(body.correctionPending).toBeUndefined();
  });

  it("names the food's kind when the factor is not its own, and ignores the burn multiplier", () => {
    const macros = { caloriesKcal: 105, proteinG: 1.3, fatG: 0.4, carbG: 27, fiberG: 3 };
    const entry: FoodLogEntry = {
      _id: new ObjectId(),
      eatenAt: new Date("2026-09-20T12:00:00.000Z"),
      createdAt: new Date("2026-09-20T12:00:00.000Z"),
      query: "banana",
      description: "banana (1 banana)",
      macros,
      items: [{ name: "banana", fdcId: 1, description: "Bananas, raw", dataType: "SR Legacy", grams: 118, servingDescription: "1 banana", macros }],
    };
    expect(serializeMeal(entry).adjusted).toBeUndefined();
    expect(serializeMeal(entry).items[0]).not.toHaveProperty("correction");

    const fit: CorrectionFit = fitEnergyWindows([]);
    fit.expenditureFactor = 2;
    const kind = fit.categories.find((category) => category.category === "discrete");
    expect(kind).toBeDefined();
    if (!kind) {
      return;
    }
    kind.applied = 1.25;
    const meal = serializeMeal(entry, fit);
    expect(meal.items[0]?.correction).toEqual({ factor: 1.25, label: "counted food" });
    expect(meal.adjusted).toEqual(
      sumMacros([
        correctedMacros(
          { name: "banana", dataType: "SR Legacy", grams: 118, servingDescription: "1 banana", macros },
          fit,
        ),
      ]),
    );
    expect(meal.macros).toEqual(macros);
    kind.applied = 1;
    expect(serializeMeal(entry, fit).adjusted).toEqual(macros);
  });
});
