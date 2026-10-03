import { describe, expect, it } from "vitest";
import { modelUsesReasoningEffort, readReasoningEffort, XaiFoodLogAi } from "./ai.js";
import { FoodLogConfigError } from "./errors.js";
import { DEFAULT_FOOD_LOG_MODEL } from "./types.js";

function fakeClient(calls: Array<Record<string, unknown>>) {
  return {
    chat: {
      completions: {
        parse: async (body: Record<string, unknown>) => {
          calls.push(body);
          return {
            choices: [
              {
                message: {
                  parsed: {
                    items: [
                      {
                        name: "water",
                        searchQueries: ["water"],
                        brandOwner: null,
                        dataTypes: null,
                        servingHint: "1 cup",
                        quantity: 1,
                      },
                    ],
                  },
                },
              },
            ],
          };
        },
      },
    },
  } as never;
}

describe("XaiFoodLogAi", () => {
  it("throws when XAI_API_KEY is missing on first request", async () => {
    const previous = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      const ai = new XaiFoodLogAi();
      await expect(ai.parseQuery("banana")).rejects.toBeInstanceOf(FoodLogConfigError);
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previous;
      }
    }
  });

  it("constructs with an explicit api key", () => {
    expect(new XaiFoodLogAi({ apiKey: "test-key" })).toBeInstanceOf(XaiFoodLogAi);
  });

  it("uses the non-reasoning model and omits reasoning effort", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const ai = new XaiFoodLogAi({ apiKey: "test-key", client: fakeClient(calls) });
    await ai.parseQuery("water");
    expect(calls[0]?.model).toBe(DEFAULT_FOOD_LOG_MODEL);
    expect(calls[0]?.model).toBe("grok-4.20-non-reasoning");
    expect(modelUsesReasoningEffort(DEFAULT_FOOD_LOG_MODEL)).toBe(false);
    expect(calls[0]).not.toHaveProperty("reasoning_effort");
  });

  it("defaults reasoning effort to low and sends it on grok-4.6", async () => {
    const previous = process.env.XAI_REASONING_EFFORT;
    delete process.env.XAI_REASONING_EFFORT;
    const calls: Array<Record<string, unknown>> = [];
    try {
      expect(readReasoningEffort()).toBe("low");
      expect(modelUsesReasoningEffort("grok-4.6")).toBe(true);
      expect(modelUsesReasoningEffort("grok-4.7-latest")).toBe(true);
      expect(modelUsesReasoningEffort("grok-4.20-0309-reasoning")).toBe(false);
      const ai = new XaiFoodLogAi({ apiKey: "test-key", model: "grok-4.6", client: fakeClient(calls) });
      await ai.parseQuery("water");
      expect(calls[0]?.reasoning_effort).toBe("low");
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_REASONING_EFFORT;
      } else {
        process.env.XAI_REASONING_EFFORT = previous;
      }
    }
  });

  it("reads XAI_REASONING_EFFORT and rejects an unknown value", () => {
    const previous = process.env.XAI_REASONING_EFFORT;
    process.env.XAI_REASONING_EFFORT = "high";
    try {
      expect(readReasoningEffort()).toBe("high");
      process.env.XAI_REASONING_EFFORT = "turbo";
      expect(() => new XaiFoodLogAi({ apiKey: "test-key" })).toThrow(FoodLogConfigError);
    } finally {
      if (previous === undefined) {
        delete process.env.XAI_REASONING_EFFORT;
      } else {
        process.env.XAI_REASONING_EFFORT = previous;
      }
    }
  });
});
