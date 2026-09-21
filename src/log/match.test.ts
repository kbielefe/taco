import { describe, expect, it } from "vitest";
import type { SearchResultFood } from "../fdc/types.js";
import { clampGrams, compactSearchCandidate, fusedSearchFoods } from "./match.js";
import type { ParsedFoodItem } from "./types.js";

function brandedCheerios(): SearchResultFood {
  return {
    fdcId: 123,
    description: "CHEERIOS, TOASTED WHOLE GRAIN OAT CEREAL",
    dataType: "Branded",
    brandOwner: "General Mills, Inc.",
    score: 800,
    servingSize: 28,
    servingSizeUnit: "g",
    householdServingFullText: "1 cup",
  };
}

describe("compactSearchCandidate", () => {
  it("scales branded serving grams by quantity", () => {
    const candidate = compactSearchCandidate(brandedCheerios(), 2);
    expect(candidate.suggestedGrams).toBe(56);
    expect(candidate.householdServingFullText).toBe("1 cup");
  });

  it("uses foodMeasures portions when present", () => {
    const candidate = compactSearchCandidate(
      {
        fdcId: 1105073,
        description: "Bananas, raw",
        dataType: "Survey (FNDDS)",
        foodMeasures: [{ disseminationText: "1 medium", gramWeight: 118 }],
      },
      1,
    );
    expect(candidate.portions).toEqual([{ description: "1 medium", grams: 118 }]);
    expect(candidate.suggestedGrams).toBe(118);
  });
});

describe("clampGrams", () => {
  it("clamps non-positive and huge values", () => {
    expect(clampGrams(0)).toBe(1);
    expect(clampGrams(-10)).toBe(1);
    expect(clampGrams(9000)).toBe(5000);
    expect(clampGrams(118)).toBe(118);
  });
});

describe("fusedSearchFoods", () => {
  it("dedupes, prefers lexical match over a higher FDC score, and truncates", () => {
    const item: ParsedFoodItem = {
      name: "Coke Zero",
      searchQueries: ["coke zero", "Coca-Cola Zero Sugar", "Coke Zero Sugar"],
      servingHint: "1 can",
      quantity: 1,
    };
    const dietCoke: SearchResultFood = {
      fdcId: 1,
      description: "Diet Coke Bottle, 1.25 Liters",
      dataType: "Branded",
      brandOwner: "Coca-Cola",
      score: 900,
    };
    const cokeZero: SearchResultFood = {
      fdcId: 2,
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      dataType: "Branded",
      brandOwner: "Coca-Cola",
      score: 200,
    };
    const lime: SearchResultFood = {
      fdcId: 3,
      description: "Coke with Lime",
      dataType: "Branded",
      score: 800,
    };
    const ranked = fusedSearchFoods([[dietCoke, lime], [cokeZero], [cokeZero]], item);
    expect(ranked[0]?.fdcId).toBe(2);
    expect(ranked.map((food) => food.fdcId)).toEqual([2, 1, 3]);
  });
});
