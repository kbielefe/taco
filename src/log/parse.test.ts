import { describe, expect, it } from "vitest";
import { ParsedMealSchema, normalizeParsedMeal } from "./parse.js";

describe("ParsedMealSchema", () => {
  it("accepts Cheerios and milk as two items", () => {
    const parsed = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "Cheerios",
            searchQuery: "Cheerios",
            fallbackQuery: "toasted oat cereal",
            brandOwner: "General Mills",
            dataTypes: ["Branded"],
            servingHint: "1 cup cereal",
            quantity: 1,
          },
          {
            name: "milk",
            searchQuery: "2% milk",
            fallbackQuery: "milk",
            brandOwner: null,
            dataTypes: ["Foundation", "SR Legacy", "Survey (FNDDS)"],
            servingHint: "1 cup milk",
            quantity: 1,
          },
        ],
      }),
    );
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.name).toBe("Cheerios");
    expect(parsed.items[1]?.searchQuery).toBe("2% milk");
  });

  it("accepts a branded Jimmy Dean egg cup as one item", () => {
    const parsed = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "Jimmy Dean egg cup",
            searchQuery: "Jimmy Dean egg cup",
            fallbackQuery: "egg cup",
            brandOwner: "Jimmy Dean",
            dataTypes: ["Branded"],
            servingHint: "1 egg cup",
            quantity: 1,
          },
        ],
      }),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.brandOwner).toBe("Jimmy Dean");
    expect(parsed.items[0]?.dataTypes).toEqual(["Branded"]);
  });

  it("accepts apple crumble cake as one prepared dish", () => {
    const parsed = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "Apple crumble cake",
            searchQuery: "apple crumble cake",
            fallbackQuery: "apple crisp",
            brandOwner: null,
            dataTypes: ["Survey (FNDDS)", "Branded"],
            servingHint: "1 slice",
            quantity: 1,
          },
        ],
      }),
    );
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0]?.dataTypes).toContain("Survey (FNDDS)");
  });

  it("accepts banana as one generic item and 2 bananas as quantity 2", () => {
    const banana = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "banana",
            searchQuery: "banana raw",
            fallbackQuery: "banana",
            brandOwner: null,
            dataTypes: ["Foundation", "SR Legacy", "Survey (FNDDS)"],
            servingHint: "1 medium banana",
            quantity: 1,
          },
        ],
      }),
    );
    expect(banana.items).toHaveLength(1);

    const two = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "banana",
            searchQuery: "banana raw",
            fallbackQuery: null,
            brandOwner: null,
            dataTypes: null,
            servingHint: "2 medium bananas",
            quantity: 2,
          },
        ],
      }),
    );
    expect(two.items[0]?.quantity).toBe(2);
    expect(two.items[0]?.fallbackQuery).toBeUndefined();
    expect(two.items[0]?.dataTypes).toBeUndefined();
  });
});
