import { describe, expect, it } from "vitest";
import { CATALOG_ID } from "../ask/catalog.js";
import type { AskModel } from "../ask/agent.js";
import { AskFailedError } from "../ask/errors.js";
import { GraphCache } from "../ask/graphs.js";
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

function appFor(options: { data?: DataCatalog; model?: AskModel; env?: NodeJS.ProcessEnv; graphCache?: GraphCache } = {}) {
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
    ...(options.graphCache ? { graphCache: options.graphCache } : {}),
  });
}

function chartMessages(title: string): unknown[] {
  return [
    { version: "v0.9", createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId: "answer",
        components: [
          {
            id: "root",
            component: "LineChart",
            title,
            unit: "days",
            series: [{ name: "Days", points: [{ label: "Mon", value: 2 }] }],
          },
        ],
      },
    },
  ];
}

function chartThenText(title: string): AskModel {
  let step = 0;
  return {
    async create() {
      step += 1;
      if (step === 1) {
        return {
          output: [
            {
              type: "function_call",
              name: "show",
              call_id: "show-1",
              arguments: JSON.stringify({ messages: chartMessages(title) }),
            },
          ],
        };
      }
      return { output: [{ type: "message", content: [{ type: "output_text", text: "Shown." }] }] };
    },
  };
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

  it("saves a shown chart and lists saved graphs newest first", async () => {
    const graphCache = new GraphCache(new MemoryCacheStore());
    const first = await post(appFor({ data, model: chartThenText("Weight"), graphCache }), {
      question: "Weight this month?",
      timeZone: "UTC",
    });
    expect(first.status).toBe(200);
    await first.text();
    const second = await post(appFor({ data, model: chartThenText("Migraines per week"), graphCache }), {
      question: "Migraines per week?",
      timeZone: "UTC",
    });
    await second.text();

    const listed = await appFor({ graphCache }).request("/api/ask/graphs");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    const body = (await listed.json()) as { graphs: { id: string; caption: string; createdAt: string }[] };
    expect(body.graphs.map((graph) => graph.caption)).toEqual(["Migraines per week", "Weight"]);
    const newest = body.graphs[0];
    const older = body.graphs[1];
    expect(newest).toBeTruthy();
    expect(older).toBeTruthy();
    expect(Date.parse(newest?.createdAt ?? "")).toBeGreaterThan(Date.parse(older?.createdAt ?? ""));

    const detail = await appFor({ graphCache }).request(`/api/ask/graphs/${newest?.id}`);
    expect(detail.status).toBe(200);
    const saved = (await detail.json()) as { caption: string; messages: unknown[] };
    expect(saved.caption).toBe("Migraines per week");
    expect(JSON.stringify(saved.messages)).toContain("Migraines per week");
  });

  it("does not save a prose answer or a chart from a failed answer", async () => {
    const graphCache = new GraphCache(new MemoryCacheStore());
    await (await post(appFor({ data, model: prose, graphCache }), { question: "Calories today?", timeZone: "UTC" })).text();
    const failing: AskModel = {
      async create() {
        throw new AskFailedError();
      },
    };
    await (await post(appFor({ data, model: failing, graphCache }), { question: "Weight?", timeZone: "UTC" })).text();
    let step = 0;
    const shownThenFailed: AskModel = {
      async create() {
        step += 1;
        if (step === 1) {
          return {
            output: [
              {
                type: "function_call",
                name: "show",
                call_id: "show-1",
                arguments: JSON.stringify({ messages: chartMessages("Migraines per week") }),
              },
            ],
          };
        }
        throw new AskFailedError();
      },
    };
    await (await post(appFor({ data, model: shownThenFailed, graphCache }), { question: "Migraines?", timeZone: "UTC" })).text();
    const listed = await appFor({ graphCache }).request("/api/ask/graphs");
    expect(await listed.json()).toEqual({ graphs: [] });
  });

  it("says a missing graph is no longer saved", async () => {
    const graphCache = new GraphCache(new MemoryCacheStore());
    const app = appFor({ graphCache });
    expect(await (await app.request("/api/ask/graphs")).json()).toEqual({ graphs: [] });
    const missing = await app.request("/api/ask/graphs/not-an-id");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { message: "That graph is no longer saved." } });
    const absent = await appFor().request("/api/ask/graphs/00000000-0000-4000-8000-000000000001");
    expect(absent.status).toBe(404);
  });

  it("serves the chart catalog", async () => {
    const response = await appFor().request("/a2ui/taco/v1/catalog.json");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { catalogId?: string };
    expect(body.catalogId).toBe(CATALOG_ID);
  });
});
