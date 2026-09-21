import { describe, expect, it } from "vitest";
import { XaiFoodLogAi } from "./ai.js";
import { FoodLogConfigError } from "./errors.js";

describe("XaiFoodLogAi", () => {
  it("throws when XAI_API_KEY is missing", () => {
    const previous = process.env.XAI_API_KEY;
    delete process.env.XAI_API_KEY;
    try {
      expect(() => new XaiFoodLogAi()).toThrow(FoodLogConfigError);
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
