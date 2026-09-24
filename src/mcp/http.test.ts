import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../fdc/cache.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import { FoodLogger } from "../log/logger.js";
import { MemoryFoodStore } from "../log/store.js";
import { createApp } from "../web/routes.js";
import type { DataCatalog, FindOptions, ReadCollection } from "./catalog.js";
import { handleMcpRequest } from "./http.js";

function catalog(partial: Partial<DataCatalog> = {}): DataCatalog {
  return {
    find: vi.fn(async () => []),
    aggregate: vi.fn(async () => []),
    count: vi.fn(async () => 0),
    indexes: vi.fn(async () => []),
    ...partial,
  };
}

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:3001/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function rpc(data: DataCatalog, method: string, params?: unknown, headers?: Record<string, string>) {
  const response = await handleMcpRequest(
    post({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }, headers),
    data,
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{ result?: Record<string, unknown>; error?: { message: string } }>;
}

function toolText(result: Record<string, unknown>): string {
  const content = result.content as { text: string }[];
  return content[0]?.text ?? "";
}

describe("MCP endpoint", () => {
  it("negotiates initialize and lists read-only tools", async () => {
    const message = await rpc(catalog(), "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(message.result).toMatchObject({
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "health-tracker", version: "0.1.0" },
    });
    expect(String(message.result?.instructions)).toContain("food");
    expect(String(message.result?.instructions)).toContain("observations");

    const listed = await rpc(catalog(), "tools/list");
    const tools = listed.result?.tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((tool) => tool.name)).toEqual([
      "list-collections",
      "collection-schema",
      "collection-indexes",
      "find",
      "aggregate",
      "count",
    ]);
    expect(tools.every((tool) => tool.annotations.readOnlyHint)).toBe(true);
  });

  it("accepts an initialized notification and answers ping", async () => {
    const response = await handleMcpRequest(
      post({ jsonrpc: "2.0", method: "notifications/initialized" }),
      catalog(),
    );
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");

    const message = await rpc(catalog(), "ping");
    expect(message.result).toEqual({});
  });

  it("rejects a browser origin that does not match a loopback host", async () => {
    const response = await handleMcpRequest(
      post(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { origin: "https://evil.example", host: "127.0.0.1:3001" },
      ),
      catalog(),
    );
    expect(response.status).toBe(403);
  });

  it("allows a same-host origin for a public hostname", async () => {
    const message = await rpc(catalog(), "ping", {}, { origin: "https://tracker.example", host: "tracker.example" });
    expect(message.result).toEqual({});
  });

  it("answers GET with 405 because there is no server stream", async () => {
    const response = await handleMcpRequest(new Request("http://127.0.0.1:3001/mcp", { method: "GET" }), catalog());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns one SSE event when the client accepts only event-stream", async () => {
    const response = await handleMcpRequest(
      post({ jsonrpc: "2.0", id: 7, method: "ping" }, { accept: "text/event-stream" }),
      catalog(),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n');
  });

  it("finds meals and preserves Extended JSON dates", async () => {
    const eatenAt = new Date("2026-09-24T15:04:05.000Z");
    const calls: { collection: ReadCollection; filter: unknown; options: FindOptions }[] = [];
    const data = catalog({
      find: vi.fn(async (collection: ReadCollection, filter: unknown, options: FindOptions) => {
        calls.push({ collection, filter, options });
        return [{ _id: new ObjectId("64b0c0ffee1234567890abcd"), eatenAt, query: "banana", macros: { caloriesKcal: 105 } }];
      }),
    });
    const message = await rpc(data, "tools/call", {
      name: "find",
      arguments: {
        collection: "food",
        filter: { eatenAt: { $gte: { $date: "2026-09-24T00:00:00.000Z" } } },
        sort: { eatenAt: -1 },
        limit: 5,
      },
    });
    expect(message.result?.isError).toBeUndefined();
    const text = toolText(message.result ?? {});
    expect(text).toContain('"$date": "2026-09-24T15:04:05Z"');
    expect(text).toContain('"$oid": "64b0c0ffee1234567890abcd"');
    expect(calls[0]?.collection).toBe("food");
    expect(calls[0]?.options).toMatchObject({ limit: 5, sort: { eatenAt: -1 } });
    const filter = calls[0]?.filter as { eatenAt: { $gte: Date } };
    expect(filter.eatenAt.$gte).toBeInstanceOf(Date);
    expect(filter.eatenAt.$gte.toISOString()).toBe("2026-09-24T00:00:00.000Z");
  });

  it("rejects other collections and write or join stages", async () => {
    const data = catalog();
    for (const pipeline of [
      [{ $out: "food" }],
      [{ $merge: { into: "food" } }],
      [{ $lookup: { from: "cache", localField: "kindId", foreignField: "_id", as: "kind" } }],
      [{ $match: { $where: "this.query.length > 0" } }],
      [{ $facet: { joined: [{ $graphLookup: { from: "kinds", startWith: "$kindId", connectFromField: "kindId", connectToField: "_id", as: "k" } }] } }],
    ]) {
      const message = await rpc(data, "tools/call", { name: "aggregate", arguments: { collection: "food", pipeline } });
      expect(message.result?.isError).toBe(true);
    }
    const hidden = await rpc(data, "tools/call", { name: "find", arguments: { collection: "cache" } });
    expect(toolText(hidden.result ?? {})).toContain("food, observations, or kinds");
    expect(data.find).not.toHaveBeenCalled();
    expect(data.aggregate).not.toHaveBeenCalled();
  });

  it("counts and samples schema from the requested collection", async () => {
    const data = catalog({
      count: vi.fn(async () => 4),
      find: vi.fn(async () => [{ at: new Date("2026-09-01T00:00:00.000Z"), values: [{ fieldId: "dose", value: 50 }] }]),
      indexes: vi.fn(async () => [{ name: "at_-1", key: { at: -1 } }]),
    });
    const count = await rpc(data, "tools/call", {
      name: "count",
      arguments: { collection: "observations", query: { kindId: { $oid: "64b0c0ffee1234567890abcd" } } },
    });
    expect(toolText(count.result ?? {})).toContain('"count": 4');

    const schema = await rpc(data, "tools/call", { name: "collection-schema", arguments: { collection: "observations", sampleSize: 3 } });
    const described = toolText(schema.result ?? {});
    expect(described).toContain('"values[].fieldId"');
    expect(described).toContain("journal entry");
    expect(data.find).toHaveBeenCalledWith("observations", {}, expect.objectContaining({ limit: 3, sort: { at: -1 } }));

    const indexes = await rpc(data, "tools/call", { name: "collection-indexes", arguments: { collection: "observations" } });
    expect(toolText(indexes.result ?? {})).toContain("at_-1");
  });

  it("drops documents until the response fits the byte limit", async () => {
    const data = catalog({
      find: vi.fn(async () => [
        { query: "a banana smoothie with oats" },
        { query: "another long meal description" },
      ]),
    });
    const message = await rpc(data, "tools/call", {
      name: "find",
      arguments: { collection: "food", responseBytesLimit: 120 },
    });
    const parsed = JSON.parse(toolText(message.result ?? {})) as { truncated: boolean; returned: number };
    expect(parsed.truncated).toBe(true);
    expect(parsed.returned).toBeLessThan(2);
  });

  it("is mounted at /mcp and stays unconfigured until a catalog is provided", async () => {
    const logger = new FoodLogger({
      fdc: {
        searchFoods: async () => ({ foods: [] }),
        getFood: async () => {
          throw new Error("unused");
        },
      },
      ai: {
        parseQuery: async () => ({ items: [] }),
        selectMatch: async () => {
          throw new Error("unused");
        },
      },
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    const journal = new Journal(new MemoryJournalStore());
    const unconfigured = await createApp({ logger, journal }).request("/mcp", { method: "POST", body: "{}" });
    expect(unconfigured.status).toBe(503);

    const configured = await createApp({ logger, journal, data: catalog() }).request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(configured.status).toBe(200);
    const message = (await configured.json()) as { result: { tools: { name: string }[] } };
    expect(message.result.tools.some((tool) => tool.name === "find")).toBe(true);
  });
});
