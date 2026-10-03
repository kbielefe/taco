import { describe, expect, it } from "vitest";
import { CATALOG_ID, CATALOG_INSTRUCTIONS, CATALOG_INSTRUCTIONS_TEMPLATE, MAX_POINTS, MAX_SERIES } from "../ask/catalog.js";
import { collectionDescription } from "../mcp/schema.js";
import { PARSE_SYSTEM_PROMPT } from "../log/parse.js";
import { formatPrompt } from "./format.js";
import { PROMPT, ASK_INSTRUCTIONS_TEMPLATE, PromptBook, publishPrompt } from "./prompts.js";

describe("prompt templates", () => {
  it("fills chart and ask placeholders", () => {
    const chart = formatPrompt(CATALOG_INSTRUCTIONS_TEMPLATE, {
      catalogId: CATALOG_ID,
      maxSeries: String(MAX_SERIES),
      maxPoints: String(MAX_POINTS),
    });
    expect(chart).toBe(CATALOG_INSTRUCTIONS);
    expect(chart).toContain("at most 4 series and 60 points");

    const ask = formatPrompt(ASK_INSTRUCTIONS_TEMPLATE, {
      timeZone: "America/Chicago",
      today: "2026-10-03",
      food: collectionDescription("food"),
      observations: collectionDescription("observations"),
      kinds: collectionDescription("kinds"),
      catalogId: CATALOG_ID,
      chartInstructions: chart,
    });
    expect(ask).toContain("The person's time zone is America/Chicago. The local date is 2026-10-03.");
    expect(ask).toContain(`food: ${collectionDescription("food")}`);
    expect(ask.endsWith(chart)).toBe(true);
    expect(ask).not.toContain("{{");
  });

  it("leaves an unknown placeholder in place", () => {
    expect(formatPrompt("Hello {{name}}", {})).toBe("Hello {{name}}");
  });
});

describe("PromptBook", () => {
  it("returns the in-code text and no URI when registration fails", async () => {
    const book = new PromptBook();
    const client = {
      latestPromptVersion: async () => {
        throw new Error("down");
      },
      createPromptVersion: async () => {
        throw new Error("down");
      },
      setAlias: async () => {
        throw new Error("down");
      },
    };
    await expect(
      book.sync(client as never, () => ({ model: "grok-4.7", reasoningEffort: "low" })),
    ).rejects.toThrow("down");
    const resolved = book.resolve(PROMPT.parse);
    expect(resolved.text).toBe(PARSE_SYSTEM_PROMPT);
    expect(resolved.uri).toBeUndefined();
    expect(resolved.version).toBeUndefined();
  });

  it("remembers a published version", async () => {
    const book = new PromptBook();
    const versions = new Map<string, string>();
    await publishPrompt(
      {
        latestPromptVersion: async () => null,
        createPromptVersion: async (input) => {
          versions.set(input.name, "1");
          return { version: "1", template: input.template };
        },
        setAlias: async (name, alias, version) => {
          expect(alias).toBe("production");
          expect(version).toBe("1");
          expect(name).toBe(PROMPT.parse);
        },
      },
      PROMPT.parse,
      { model: "grok-4.7", reasoningEffort: "low" },
    );
    book.remember(PROMPT.parse, "1");
    expect(book.resolve(PROMPT.parse).uri).toBe("prompts:/taco.parse/1");
  });
});
