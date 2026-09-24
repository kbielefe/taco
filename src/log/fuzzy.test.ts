import { describe, expect, it } from "vitest";
import { fuzzyMatch, pickSuggestions } from "./fuzzy.js";

describe("fuzzyMatch", () => {
  it("matches anywhere, in either word order, and with a small typo", () => {
    expect(fuzzyMatch("bread", "Banana bread")).toBe(true);
    expect(fuzzyMatch("milk cheer", "Cheerios and milk")).toBe(true);
    expect(fuzzyMatch("bananna", "banana")).toBe(true);
    expect(fuzzyMatch("wieght", "Weight")).toBe(true);
    expect(fuzzyMatch("oml", "oatmeal")).toBe(true);
    expect(fuzzyMatch("zz", "banana")).toBe(false);
    expect(fuzzyMatch("", "anything")).toBe(true);
  });
});

describe("pickSuggestions", () => {
  it("keeps the most recent matches, then shows them alphabetically", () => {
    const recentFirst = ["oatmeal", "Banana bread", "banana", "milk"];
    expect(pickSuggestions(recentFirst, "a", 2)).toEqual(["Banana bread", "oatmeal"]);
    expect(pickSuggestions(["Banana bread", "banana"], "nana", 8)).toEqual(["banana", "Banana bread"]);
  });
});
