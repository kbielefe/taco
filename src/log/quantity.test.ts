import { describe, expect, it } from "vitest";
import { foodPhraseHasJoin, nameWithoutLeadingQuantity, splitLeadingQuantity } from "./quantity.js";

describe("splitLeadingQuantity", () => {
  it("reads a leading count as the quantity of the food", () => {
    expect(splitLeadingQuantity("2 fried rice")).toEqual({ quantity: 2, food: "fried rice" });
    expect(splitLeadingQuantity("  2x fried rice ")).toEqual({ quantity: 2, food: "fried rice" });
    expect(splitLeadingQuantity("2 x fried rice")).toEqual({ quantity: 2, food: "fried rice" });
    expect(splitLeadingQuantity("2× fried rice")).toEqual({ quantity: 2, food: "fried rice" });
    expect(splitLeadingQuantity("1 fried rice")).toEqual({ quantity: 1, food: "fried rice" });
  });

  it("leaves measurements and other wording alone", () => {
    expect(splitLeadingQuantity("2 cups of fried rice")).toBeUndefined();
    expect(splitLeadingQuantity("2 cups fried rice")).toBeUndefined();
    expect(splitLeadingQuantity("200 g chicken")).toBeUndefined();
    expect(splitLeadingQuantity("2% milk")).toBeUndefined();
    expect(splitLeadingQuantity("2.5 fried rice")).toBeUndefined();
    expect(splitLeadingQuantity("fried rice")).toBeUndefined();
    expect(splitLeadingQuantity("25 fried rice")).toBeUndefined();
    expect(splitLeadingQuantity("0 fried rice")).toBeUndefined();
  });
});

describe("foodPhraseHasJoin", () => {
  it("notices a second food", () => {
    expect(foodPhraseHasJoin("fried rice")).toBe(false);
    expect(foodPhraseHasJoin("mac and cheese")).toBe(true);
    expect(foodPhraseHasJoin("bananas and milk")).toBe(true);
    expect(foodPhraseHasJoin("rice with beans")).toBe(true);
  });
});

describe("nameWithoutLeadingQuantity", () => {
  it("uses the leading count when the model left quantity at 1", () => {
    expect(nameWithoutLeadingQuantity("2 fried rice", 1)).toEqual({ name: "fried rice", quantity: 2 });
  });

  it("keeps an explicit quantity and still drops the count from the name", () => {
    expect(nameWithoutLeadingQuantity("2 fried rice", 2)).toEqual({ name: "fried rice", quantity: 2 });
    expect(nameWithoutLeadingQuantity("2 fried rice", 3)).toEqual({ name: "fried rice", quantity: 3 });
  });
});
