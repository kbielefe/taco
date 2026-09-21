import { describe, expect, it } from "vitest";
import { ParsedMealSchema, normalizeParsedMeal, uniqueSearchQueries } from "./parse.js";

describe("ParsedMealSchema", () => {
  it("accepts Cheerios and milk as two items", () => {
    const parsed = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "Cheerios",
            searchQueries: ["Cheerios", "Cheerios toasted oat cereal", "toasted whole grain oat cereal"],
            brandOwner: "General Mills",
            dataTypes: ["Branded"],
            servingHint: "1 cup cereal",
            quantity: 1,
          },
          {
            name: "milk",
            searchQueries: ["2% milk", "milk", "reduced fat milk"],
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
    expect(parsed.items[1]?.searchQueries).toContain("2% milk");
    expect(parsed.items[0]?.searchQueries).toContain("General Mills Cheerios");
  });

  it("accepts a branded Jimmy Dean egg cup as one item", () => {
    const parsed = normalizeParsedMeal(
      ParsedMealSchema.parse({
        items: [
          {
            name: "Jimmy Dean egg cup",
            searchQueries: ["Jimmy Dean egg cup", "Jimmy Dean breakfast cup", "egg bite cup"],
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
            searchQueries: ["apple crumble cake", "apple crisp", "apple crumble"],
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
            searchQueries: ["banana raw", "banana", "bananas"],
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
            searchQueries: ["banana raw"],
            brandOwner: null,
            dataTypes: null,
            servingHint: "2 medium bananas",
            quantity: 2,
          },
        ],
      }),
    );
    expect(two.items[0]?.quantity).toBe(2);
    expect(two.items[0]?.searchQueries).toEqual(["banana raw", "banana"]);
    expect(two.items[0]?.dataTypes).toBeUndefined();
  });
});

describe("uniqueSearchQueries", () => {
  it("trims, dedupes case-insensitively, and caps the list", () => {
    expect(
      uniqueSearchQueries(["  Coke Zero  ", "coke zero", "Coca-Cola Zero Sugar", "", "diet coke", "zero sugar cola", "cola"]),
    ).toEqual(["Coke Zero", "Coca-Cola Zero Sugar", "diet coke", "zero sugar cola", "cola"]);
  });
});
