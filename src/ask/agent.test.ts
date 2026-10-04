import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { DataCatalog } from "../mcp/catalog.js";
import { DEFAULT_FOOD_LOG_MODEL } from "../log/types.js";
import { CATALOG_ID } from "./catalog.js";
import { AskFailedError } from "./errors.js";
import { createXaiAskModel, runAsk, type AskEvent, type AskModel } from "./agent.js";

const data: DataCatalog = {
  async find() {
    return [{ description: "banana" }];
  },
  async aggregate() {
    return [];
  },
  async count() {
    return 0;
  },
  async indexes() {
    return [];
  },
};

function call(name: string, args: unknown, callId: string): { type: "function_call"; name: string; arguments: string; call_id: string } {
  return { type: "function_call", name, arguments: JSON.stringify(args), call_id: callId };
}

function text(value: string): { type: "message"; content: Array<{ type: "output_text"; text: string }> } {
  return { type: "message", content: [{ type: "output_text", text: value }] };
}

function chartMessages(): unknown[] {
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
            title: "Calories",
            unit: "kcal",
            series: [{ name: "Calories", points: [{ label: "Mon", value: 1800 }, { label: "Tue", value: 1900 }] }],
          },
        ],
      },
    },
  ];
}

function scripted(steps: unknown[][]): { model: AskModel; inputs: unknown[][] } {
  const inputs: unknown[][] = [];
  return {
    inputs,
    model: {
      async create(request) {
        inputs.push(request.input);
        const output = steps.shift();
        if (!output) {
          throw new Error("The script ended.");
        }
        return { output };
      },
    },
  };
}

async function ask(model: AskModel): Promise<AskEvent[]> {
  const events: AskEvent[] = [];
  await runAsk({
    question: "Calories this week?",
    timeZone: "America/Chicago",
    today: "2026-10-03",
    history: [],
    data,
    model,
    emit: async (event) => {
      events.push(event);
    },
  });
  return events;
}

describe("runAsk", () => {
  it("looks up data, corrects a chart, and then answers", async () => {
    const { model, inputs } = scripted([
      [call("find", { collection: "food", filter: { query: "secret meal" } }, "find-1")],
      [
        call(
          "show",
          {
            messages: [
              { version: "v0.9", createSurface: { surfaceId: "answer", catalogId: "https://example.com/no" } },
              { version: "v0.9", updateComponents: { surfaceId: "answer", components: [] } },
            ],
          },
          "show-1",
        ),
      ],
      [call("show", { messages: chartMessages() }, "show-2")],
      [text("About 1,850 kcal a day.")],
    ]);
    const events = await ask(model);
    expect(events.map((event) => event.type === "status" ? event.message : event.type)).toEqual([
      "Looking up meals.",
      "a2ui",
      "a2ui",
      "text",
    ]);
    expect(events.some((event) => event.type === "status" && event.message.includes("secret"))).toBe(false);
    expect(JSON.stringify(inputs[1])).toContain("banana");
    expect(JSON.stringify(inputs[2])).toContain(CATALOG_ID);
    expect(events.filter((event) => event.type === "a2ui")).toHaveLength(2);
    expect(events.at(-1)).toEqual({ type: "text", text: "About 1,850 kcal a day." });
  });

  it("shows one surface and tells the model not to send another", async () => {
    const { model, inputs } = scripted([
      [call("show", { messages: chartMessages() }, "show-1")],
      [call("show", { messages: chartMessages() }, "show-2")],
      [text("That is the week.")],
    ]);
    const events = await ask(model);
    expect(events.filter((event) => event.type === "a2ui")).toHaveLength(2);
    expect(JSON.stringify(inputs[2])).toContain("already shown");
  });

  it("answers in prose when no chart is needed", async () => {
    const { model } = scripted([[text("Nothing logged today.")]]);
    await expect(ask(model)).resolves.toEqual([{ type: "text", text: "Nothing logged today." }]);
  });

  it("stops after too many tool rounds with nothing to show", async () => {
    const steps = Array.from({ length: 8 }, () => [call("count", { collection: "food" }, "count")]);
    const { model, inputs } = scripted(steps);
    await expect(ask(model)).rejects.toBeInstanceOf(AskFailedError);
    expect(inputs).toHaveLength(8);
  });

  it("should keep the question and earlier results when another round runs", async () => {
    const { model, inputs } = scripted([
      [call("find", { collection: "kinds" }, "find-1")],
      [call("find", { collection: "observations" }, "find-2")],
      [text("September 30.")],
    ]);
    await runAsk({
      question: "What day was the 6am migraine?",
      timeZone: "America/Chicago",
      today: "2026-10-03",
      history: [
        { role: "user", content: "show a histogram of migraine hour" },
        { role: "assistant", content: "Shown above.\nHour of day\n6 1" },
      ],
      data,
      model,
      emit: async () => undefined,
    });
    expect(labels(inputs[0])).toEqual([
      "user:show a histogram of migraine hour",
      "assistant:Shown above.\nHour of day\n6 1",
      "user:What day was the 6am migraine?",
    ]);
    expect(labels(inputs[1])).toEqual([
      "user:show a histogram of migraine hour",
      "assistant:Shown above.\nHour of day\n6 1",
      "user:What day was the 6am migraine?",
      "call:find",
      "result:banana",
    ]);
    expect(labels(inputs[2])).toEqual([
      "user:show a histogram of migraine hour",
      "assistant:Shown above.\nHour of day\n6 1",
      "user:What day was the 6am migraine?",
      "call:find",
      "result:banana",
      "call:find",
      "result:banana",
    ]);
  });
});

function labels(items: unknown[]): string[] {
  return items.map((item) => {
    if (!item || typeof item !== "object") {
      return "?";
    }
    const record = item as Record<string, unknown>;
    if (typeof record.role === "string") {
      return `${record.role}:${String(record.content)}`;
    }
    if (record.type === "function_call") {
      return `call:${String(record.name)}`;
    }
    if (record.type === "function_call_output") {
      return `result:${String(record.output).includes("banana") ? "banana" : "other"}`;
    }
    return String(record.type);
  });
}

describe("createXaiAskModel", () => {
  it("uses grok-4.7 and medium effort without reading the food-log effort", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      responses: {
        create: async (body: Record<string, unknown>) => {
          calls.push(body);
          return { output: [text("ok")] };
        },
      },
    };
    const model = createXaiAskModel({
      env: { XAI_API_KEY: "test-key", XAI_REASONING_EFFORT: "low" },
      client: client as unknown as OpenAI,
    });
    await model.create({ instructions: "Be brief.", input: [{ role: "user", content: "Hi" }] });
    expect(calls[0]?.model).toBe(DEFAULT_FOOD_LOG_MODEL);
    expect(calls[0]?.model).toBe("grok-4.7");
    expect(calls[0]?.reasoning).toEqual({ effort: "medium" });
    expect(calls[0]?.store).toBe(false);
    const tools = calls[0]?.tools as Array<{ name?: string }>;
    expect(tools.some((tool) => tool.name === "show")).toBe(true);
    expect(tools.some((tool) => tool.name === "collection-indexes")).toBe(false);
  });
});
