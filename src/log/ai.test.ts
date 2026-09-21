import { describe, expect, it } from "vitest";
import { XaiFoodLogAi } from "./ai.js";
import { FoodLogConfigError } from "./errors.js";

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
});
