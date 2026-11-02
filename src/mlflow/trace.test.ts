import { ObjectId } from "mongodb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { context, trace, type Attributes, type Context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { TracerProvider, type ReadableSpan, type Span as SdkSpan, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { createCorrectionRunner } from "../correct/run.js";
import { FdcClient, fdcSearchInputs } from "../fdc/client.js";
import { MemoryCacheStore, MongoCacheStore } from "../fdc/cache.js";
import type { FoodItem } from "../fdc/types.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import { XaiFoodLogAi } from "../log/ai.js";
import { FoodLogger } from "../log/logger.js";
import { MongoFoodStore } from "../log/store.js";
import { DEFAULT_FOOD_LOG_MODEL, FOOD_LOG_CACHE_SOURCE } from "../log/types.js";
import { createApp } from "../web/routes.js";
import { requestPreview, shouldTraceRequest } from "./http.js";
import { createSessionId, readSessionId, SESSION_MAX_AGE, sessionCookieOptions } from "./session.js";
import { disableTracing, enableTracing, holdUntilBody, traceHttp, withMlflowSpan } from "./tracing.js";

interface RecordedSpan {
  name: string;
  spanId: string;
  traceId: string;
  parentId?: string;
  attributes: Attributes;
  ended: boolean;
}

const recorder = {
  spans: [] as RecordedSpan[],
  reset(): void {
    this.spans.length = 0;
  },
};

const processor: SpanProcessor = {
  onStart(span: SdkSpan, parentContext: Context): void {
    const parent = trace.getSpan(parentContext)?.spanContext().spanId;
    recorder.spans.push({
      name: span.name,
      spanId: span.spanContext().spanId,
      traceId: span.spanContext().traceId,
      ...(parent ? { parentId: parent } : {}),
      attributes: {},
      ended: false,
    });
  },
  onEnd(span: ReadableSpan): void {
    const recorded = recorder.spans.find((item) => item.spanId === span.spanContext().spanId);
    if (!recorded) return;
    recorded.ended = true;
    recorded.attributes = span.attributes;
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

beforeEach(() => {
  recorder.reset();
  const manager = new AsyncLocalStorageContextManager();
  manager.enable();
  context.setGlobalContextManager(manager);
  const provider = new TracerProvider({ spanProcessors: [processor] });
  trace.setGlobalTracerProvider(provider);
  enableTracing(() => provider.shutdown());
});

afterEach(async () => {
  await disableTracing();
});

describe("trace session", () => {
  it("issues a 32 character id and keeps a valid one", () => {
    const created = createSessionId();
    expect(created).toMatch(/^[a-f0-9]{32}$/);
    expect(readSessionId(created)).toBe(created);
    expect(readSessionId("nope")).toBeUndefined();
    expect(readSessionId(undefined)).toBeUndefined();
  });

  it("marks only an https cookie as secure", () => {
    expect(sessionCookieOptions("https:").secure).toBe(true);
    expect(sessionCookieOptions("http:").secure).toBe(false);
    expect(sessionCookieOptions("http:").maxAge).toBe(SESSION_MAX_AGE);
    expect(sessionCookieOptions("http:").httpOnly).toBe(true);
  });

  it("skips health, events, and static catalog routes", () => {
    expect(shouldTraceRequest("/api/health")).toBe(false);
    expect(shouldTraceRequest("/api/events")).toBe(false);
    expect(shouldTraceRequest("/a2ui/taco/v1/catalog.json")).toBe(false);
    expect(shouldTraceRequest("/api/meals")).toBe(true);
    expect(shouldTraceRequest("/mcp")).toBe(true);
  });
});

describe("request preview", () => {
  it("uses the meal text or the ask question", () => {
    expect(requestPreview("POST", "/api/meals", {}, { query: "banana" })).toBe("POST /api/meals banana");
    expect(requestPreview("POST", "/api/ask", {}, { question: "how much protein" })).toBe(
      "POST /api/ask how much protein",
    );
    expect(requestPreview("GET", "/api/meals", { from: "2026-10-03", api_key: "secret" }, undefined)).toBe(
      "GET /api/meals?from=2026-10-03&api_key=REDACTED",
    );
  });

  it("keeps the search query and leaves the api key out", () => {
    const inputs = fdcSearchInputs({ query: "banana", dataType: ["SR Legacy"], pageSize: 8 });
    expect(inputs).toMatchObject({ query: "banana", dataType: ["SR Legacy"], pageSize: 8 });
    expect(JSON.stringify(inputs)).not.toContain("api_key");
  });
});

describe("holdUntilBody", () => {
  it("lets the caller read bytes before the hold resolves", async () => {
    let push: ((value: Uint8Array) => void) | undefined;
    let close: (() => void) | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (value) => controller.enqueue(value);
        close = () => controller.close();
      },
    });
    const { response, done } = holdUntilBody(new Response(stream, { status: 201 }));
    let resolved = false;
    const finished = done.then((value) => {
      resolved = true;
      return value;
    });
    push?.(new TextEncoder().encode("hello"));
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("hello");
    await Promise.resolve();
    expect(resolved).toBe(false);
    close?.();
    await reader?.read();
    await expect(finished).resolves.toBe("hello");
  });

  it("resolves when the request is aborted", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start() {},
    });
    const { done } = holdUntilBody(new Response(stream), controller.signal);
    const pending = done.then((value) => value);
    controller.abort();
    await expect(pending).resolves.toBe("");
  });
});

describe("span contents", () => {
  it("records the model and token counts and leaves the prompt out", async () => {
    await withMlflowSpan(
      {
        name: "parse meal",
        spanType: "LLM",
        model: "grok-4.7",
        inputs: { messages: [{ role: "system", content: "SECRET PROMPT banana" }] },
      },
      async () => ({
        result: "ok",
        outputs: { meal: "banana" },
        usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
      }),
    );
    const span = recorder.spans.find((item) => item.name === "taco parse meal");
    expect(span?.attributes["gen_ai.request.model"]).toBe("grok-4.7");
    expect(span?.attributes["gen_ai.provider.name"]).toBe("xai");
    expect(span?.attributes["gen_ai.usage.input_tokens"]).toBe(3);
    expect(span?.attributes["gen_ai.usage.output_tokens"]).toBe(4);
    const recorded = JSON.stringify(span);
    expect(recorded).not.toContain("SECRET PROMPT");
    expect(recorded).not.toContain("banana");
  });
});

describe("meal log trace", () => {
  it("keeps one root open until the streamed meal is written", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const client = {
      chat: {
        completions: {
          parse: async () => {
            calls += 1;
            if (calls === 1) {
              await gate;
            }
            if (calls === 1) {
              return {
                choices: [
                  {
                    message: {
                      parsed: {
                        items: [
                          {
                            name: "banana",
                            searchQueries: ["banana"],
                            brandOwner: null,
                            dataTypes: null,
                            servingHint: "1 banana",
                            quantity: 1,
                          },
                        ],
                      },
                    },
                  },
                ],
              };
            }
            return {
              choices: [{ message: { parsed: { fdcId: 1, grams: 118, servingDescription: "1 banana" } } }],
            };
          },
        },
      },
    };
    const fetchMock = vi.fn(async (url: URL | string) => {
      const href = String(url);
      if (href.includes("/foods/search")) {
        return Response.json({
          foods: [{ fdcId: 1, description: "Bananas, raw", dataType: "SR Legacy", score: 100 }],
        });
      }
      return Response.json(banana());
    });
    const app = createApp({
      logger: new FoodLogger({
        fdc: new FdcClient({ apiKey: "test-key", cache: new MemoryCacheStore(), fetch: fetchMock }),
        ai: new XaiFoodLogAi({ apiKey: "test-key", client: client as never, reasoningEffort: "low" }),
        queryCache: new MongoCacheStore(
          {
            collectionName: "cache",
            async findOne() {
              return null;
            },
            async replaceOne() {
              return { acknowledged: true };
            },
          } as never,
          FOOD_LOG_CACHE_SOURCE,
        ),
        foodStore: new MongoFoodStore({
          collectionName: "food",
          async insertOne() {
            return { insertedId: new ObjectId() };
          },
        } as never),
      }),
      journal: new Journal(new MemoryJournalStore()),
    });

    const health = await app.request("http://127.0.0.1/api/health");
    expect(health.headers.get("set-cookie")).toBeNull();

    const response = await app.request("http://127.0.0.1/api/meals", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
      body: JSON.stringify({ query: "banana" }),
    });
    const root = (): RecordedSpan | undefined =>
      recorder.spans.find((span) => span.name === "taco POST /api/meals" && !span.parentId);
    expect(recorder.spans.filter((span) => !span.parentId)).toHaveLength(1);
    expect(root()?.ended).toBe(false);

    release();
    const text = await response.text();
    expect(text).toContain('"type":"result"');
    await vi.waitFor(() => expect(root()?.ended).toBe(true));

    const names = recorder.spans.map((span) => span.name);
    expect(names).toEqual(expect.arrayContaining([
      "taco mongo cache.get",
      "taco parse meal",
      "taco fdc search",
      "taco fdc POST /v1/foods/search",
      "taco select match",
      "taco fdc get",
      "taco fdc GET /v1/food/1",
      "taco mongo cache.set",
      "taco mongo food.insert",
    ]));
    const spanNamed = (name: string): RecordedSpan | undefined => recorder.spans.find((span) => span.name === name);
    expect(spanNamed("taco mongo cache.get")?.parentId).toBe(root()?.spanId);
    expect(spanNamed("taco parse meal")?.parentId).toBe(root()?.spanId);
    expect(spanNamed("taco fdc POST /v1/foods/search")?.parentId).toBe(spanNamed("taco fdc search")?.spanId);
    expect(spanNamed("taco fdc GET /v1/food/1")?.parentId).toBe(spanNamed("taco fdc get")?.spanId);
    expect(spanNamed("taco mongo cache.set")?.parentId).toBe(root()?.spanId);
    expect(spanNamed("taco mongo food.insert")?.parentId).toBe(root()?.spanId);
    expect(recorder.spans.filter((span) => !span.parentId)).toHaveLength(1);
    for (const span of recorder.spans) {
      if (span.parentId) {
        expect(recorder.spans.some((parent) => parent.spanId === span.parentId)).toBe(true);
      }
    }
    const search = recorder.spans.find((span) => span.name === "taco fdc search");
    expect(search?.attributes["taco.cache"]).toBe("miss");
    const parse = spanNamed("taco parse meal");
    expect(parse?.attributes["gen_ai.request.model"]).toBe(DEFAULT_FOOD_LOG_MODEL);
    expect(parse?.attributes["gen_ai.provider.name"]).toBe("xai");
    expect(root()?.attributes["http.request.method"]).toBe("POST");
    expect(root()?.attributes["url.path"]).toBe("/api/meals");
    expect(root()?.attributes["http.response.status_code"]).toBe(200);
    const recorded = JSON.stringify(recorder.spans);
    expect(recorded).not.toContain("api_key");
    expect(recorded).not.toContain("banana");
    expect(recorded).not.toContain("test-key");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE}`);
    expect(cookie.toLowerCase()).not.toContain("secure");
    const sessionId = /taco-session=([a-f0-9]{32})/.exec(cookie)?.[1];
    expect(sessionId).toMatch(/^[a-f0-9]{32}$/);
    expect(recorded).not.toContain(sessionId);

    recorder.reset();
    const again = await app.request("http://127.0.0.1/api/journal/kinds", {
      headers: { cookie: `taco-session=${sessionId}` },
    });
    expect(again.headers.get("set-cookie")).toBeNull();
    await again.json();
    await vi.waitFor(() =>
      expect(recorder.spans.find((span) => span.name === "taco GET /api/journal/kinds")?.ended).toBe(true),
    );
    expect(JSON.stringify(recorder.spans)).not.toContain(sessionId);

    const secure = await app.request("https://example.com/api/journal/kinds");
    expect(secure.headers.get("set-cookie")?.toLowerCase()).toContain("secure");
    await secure.json();
  });

  it("records a cache hit without an FDC http span", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ foods: [{ fdcId: 1, description: "Bananas, raw", dataType: "SR Legacy", score: 100 }] }),
    );
    const fdc = new FdcClient({ apiKey: "test-key", cache: new MemoryCacheStore(), fetch: fetchMock });
    await fdc.searchFoods({ query: "banana", pageSize: 8 });
    recorder.reset();
    await fdc.searchFoods({ query: "banana", pageSize: 8 });
    const names = recorder.spans.map((span) => span.name);
    expect(names).toContain("taco fdc search");
    expect(names.some((name) => name.startsWith("taco fdc POST"))).toBe(false);
    expect(recorder.spans.find((span) => span.name === "taco fdc search")?.attributes["taco.cache"]).toBe("hit");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records a correction fit as its own trace", async () => {
    const runner = createCorrectionRunner({
      store: {
        async read() {
          return null;
        },
        async save() {},
      },
      load: async () => ({ meals: [], observations: [] }),
      env: {},
      onError() {},
    });
    const response = await traceHttp(
      {
        name: "POST /api/journal/observations",
      },
      async () => {
        runner.schedule({ timeZone: "UTC" });
        return new Response("saved", { status: 201 });
      },
    );
    expect(await response.text()).toBe("saved");
    await runner.whenIdle();
    await vi.waitFor(() =>
      expect(recorder.spans.find((span) => span.name === "taco POST /api/journal/observations")?.ended).toBe(true),
    );
    const fit = recorder.spans.find((span) => span.name === "taco fit corrections");
    const request = recorder.spans.find((span) => span.name === "taco POST /api/journal/observations");
    expect(fit?.parentId).toBeUndefined();
    expect(fit?.ended).toBe(true);
    expect(request?.parentId).toBeUndefined();
    expect(fit?.spanId).not.toBe(request?.spanId);
  });
});

function banana(): FoodItem {
  return {
    fdcId: 1,
    dataType: "SR Legacy",
    description: "Bananas, raw",
    foodNutrients: [
      { amount: 89, nutrient: { id: 1008, number: "208", name: "Energy", unitName: "KCAL" } },
      { amount: 1, nutrient: { id: 1003, number: "203", name: "Protein", unitName: "G" } },
      { amount: 1, nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "G" } },
      { amount: 10, nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "G" } },
      { amount: 1, nutrient: { id: 1079, number: "291", name: "Fiber, total dietary", unitName: "G" } },
    ],
  };
}
