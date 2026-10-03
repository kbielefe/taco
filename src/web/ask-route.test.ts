import { describe, expect, it } from "vitest";
import { CATALOG_ID } from "../ask/catalog.js";
import type { AskModel } from "../ask/agent.js";
import { AskFailedError } from "../ask/errors.js";
import { MemoryCacheStore } from "../fdc/cache.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import { FoodLogger } from "../log/logger.js";
import { MemoryFoodStore } from "../log/store.js";
import type { DataCatalog } from "../mcp/catalog.js";
import { createApp } from "./routes.js";

const data: DataCatalog = {
  find: async () => [],
  aggregate: async () => [],
  count: async () => 0,
  indexes: async () => [],
};

function appFor(options: { data?: DataCatalog; model?: AskModel; env?: NodeJS.ProcessEnv } = {}) {
  const logger = new FoodLogger({
    fdc: {
      searchFoods: async () => ({ foods: [] }),
      getFood: async () => {
        throw new Error("unused");
      },
    },
    ai: {
      parseQuery: async () => {
        throw new Error("unused");
      },
      selectMatch: async () => {
        throw new Error("unused");
      },
    },
    queryCache: new MemoryCacheStore(),
    foodStore: new MemoryFoodStore(),
  });
  return createApp({
    logger,
    journal: new Journal(new MemoryJournalStore()),
    env: options.env ?? {},
    ...(options.data ? { data: options.data } : {}),
    ...(options.model ? { askModel: options.model } : {}),
  });
}

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request("/api/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const prose: AskModel = {
  async create() {
    return { output: [{ type: "message", content: [{ type: "output_text", text: "About 1,800 kcal." }] }] };
  },
};

describe("ask HTTP API", () => {
  it("rejects an empty question", async () => {
    const response = await post(appFor({ data }), { question: "  ", timeZone: "UTC" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { message: "Enter a question." } });
  });

  it("reports a missing data connection and a missing API key", async () => {
    const disconnected = await post(appFor(), { question: "Weight?", timeZone: "UTC" });
    expect(disconnected.status).toBe(503);
    expect(await disconnected.json()).toEqual({ error: { message: "The health data isn't connected." } });

    const unsigned = await post(appFor({ data, env: {} }), { question: "Weight?", timeZone: "UTC" });
    expect(unsigned.status).toBe(503);
    expect(await unsigned.json()).toEqual({ error: { message: "Couldn't ask that. Set XAI_API_KEY in .env." } });
  });

  it("streams an answer as NDJSON", async () => {
    const response = await post(appFor({ data, model: prose }), { question: "Calories today?", timeZone: "America/Chicago" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as unknown);
    expect(lines).toEqual([
      { type: "text", text: "About 1,800 kcal." },
      { type: "done" },
    ]);
  });

  it("streams a model failure", async () => {
    const model: AskModel = {
      async create() {
        throw new AskFailedError();
      },
    };
    const response = await post(appFor({ data, model }), { question: "Calories today?", timeZone: "UTC" });
    expect(response.status).toBe(200);
    const lines = (await response.text()).trim().split("\n").map((line) => JSON.parse(line) as { type: string });
    expect(lines).toEqual([
      { type: "error", error: { message: "Couldn't answer that. Try again in a moment." }, status: 422 },
    ]);
  });

  it("serves the chart catalog", async () => {
    const response = await appFor().request("/a2ui/taco/v1/catalog.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { catalogId?: string };
    expect(body.catalogId).toBe(CATALOG_ID);
  });
});
