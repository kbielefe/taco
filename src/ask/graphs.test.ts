import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CATALOG_ID } from "./catalog.js";
import { MemoryCacheStore, type CacheListEntry, type CacheStore } from "../fdc/cache.js";
import { GRAPH_CACHE_TTL_MS, GraphCache, graphCacheKey, graphCaption, type SavedGraphSummary } from "./graphs.js";
import type { A2uiMessage } from "./validate.js";

function chart(title: string): A2uiMessage[] {
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

class RecordingStore implements CacheStore {
  ttlMs = 0;
  async get(): Promise<undefined> {
    return undefined;
  }
  async set(_key: string, _value: unknown, ttlMs: number): Promise<void> {
    this.ttlMs = ttlMs;
  }
  async delete(): Promise<boolean> {
    return false;
  }
  async listRecent(): Promise<CacheListEntry[]> {
    return [];
  }
}

describe("graphCaption", () => {
  it("uses the chart title as the short caption", () => {
    expect(graphCaption(chart("Migraines   per\nweek"))).toBe("Migraines per week");
  });

  it("skips a surface that has no chart", () => {
    const messages: A2uiMessage[] = [
      { version: "v0.9", createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "answer",
          components: [{ id: "root", component: "Text", text: "About 1,800 kcal.", variant: "body" }],
        },
      },
    ];
    expect(graphCaption(messages)).toBeUndefined();
  });
});

describe("GraphCache", () => {
  it("keeps a shown chart for one year", async () => {
    const store = new RecordingStore();
    const id = await new GraphCache(store).remember(chart("Migraines per week"));
    expect(id).toBeTruthy();
    expect(store.ttlMs).toBe(GRAPH_CACHE_TTL_MS);
    expect(GRAPH_CACHE_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });

  it("lists saved charts newest first and loads one by id", async () => {
    const cache = new GraphCache(new MemoryCacheStore());
    await cache.remember(chart("Weight"));
    await cache.remember(chart("Migraines per week"));
    const listed = await cache.list();
    expect(listed.map((graph) => graph.caption)).toEqual(["Migraines per week", "Weight"]);
    const newest = listed[0] as SavedGraphSummary;
    const older = listed[1] as SavedGraphSummary;
    expect(newest.createdAt.getTime()).toBeGreaterThan(older.createdAt.getTime());

    const saved = await cache.get(newest.id);
    expect(saved?.caption).toBe("Migraines per week");
    expect(JSON.stringify(saved?.messages)).toContain("Migraines per week");
    expect(await cache.get(older.id)).toMatchObject({ caption: "Weight" });
  });

  it("ignores a prose surface, a bad id, and a corrupt entry", async () => {
    const store = new MemoryCacheStore();
    const cache = new GraphCache(store);
    const messages: A2uiMessage[] = [
      { version: "v0.9", createSurface: { surfaceId: "answer", catalogId: CATALOG_ID } },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: "answer",
          components: [{ id: "root", component: "Text", text: "Nothing logged.", variant: "body" }],
        },
      },
    ];
    expect(await cache.remember(messages)).toBeUndefined();
    await store.set(graphCacheKey(randomUUID()), { caption: "Broken" }, GRAPH_CACHE_TTL_MS);
    await store.set("ask-graph:v1:not-a-uuid", { caption: "Also broken" }, GRAPH_CACHE_TTL_MS);
    await cache.remember(chart("Weight"));
    const listed = await cache.list();
    expect(listed.map((graph) => graph.caption)).toEqual(["Weight"]);
    expect(await cache.get("not-an-id")).toBeUndefined();
    expect(await cache.get(randomUUID())).toBeUndefined();
  });
});
