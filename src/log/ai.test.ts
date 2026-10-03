import { describe, expect, it } from "vitest";
import { readAskReasoningEffort, readReasoningEffort, XaiFoodLogAi } from "./ai.js";
import { FoodLogConfigError } from "./errors.js";
import { DEFAULT_FOOD_LOG_MODEL } from "./types.js";

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

  it("defaults reasoning effort to low and sends it on the request", async () => {
    const previous = process.env.XAI_REASONING_EFFORT;
    delete process.env.XAI_REASONING_EFFORT;
    const calls: Array<Record<string, unknown>> = [];
    const client = {
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
    };
    try {
      expect(readReasoningEffort()).toBe("low");
      const ai = new XaiFoodLogAi({ apiKey: "test-key", client: client as never });
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

  it("uses grok-4.7 for meal logging", () => {
    expect(DEFAULT_FOOD_LOG_MODEL).toBe("grok-4.7");
  });

  it("defaults ask effort to medium and ignores the food-log effort", () => {
    const previousAsk = process.env.XAI_ASK_REASONING_EFFORT;
    const previous = process.env.XAI_REASONING_EFFORT;
    delete process.env.XAI_ASK_REASONING_EFFORT;
    process.env.XAI_REASONING_EFFORT = "low";
    try {
      expect(readAskReasoningEffort()).toBe("medium");
      expect(readAskReasoningEffort(undefined, { XAI_REASONING_EFFORT: "high", XAI_ASK_REASONING_EFFORT: "xhigh" })).toBe(
        "xhigh",
      );
      expect(() => readAskReasoningEffort("turbo")).toThrow(/XAI_ASK_REASONING_EFFORT/);
    } finally {
      if (previousAsk === undefined) {
        delete process.env.XAI_ASK_REASONING_EFFORT;
      } else {
        process.env.XAI_ASK_REASONING_EFFORT = previousAsk;
      }
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
