import { describe, expect, it } from "vitest";
import type { FoodItem, FoodNutrient } from "../fdc/types.js";
import { FoodLogMatchError } from "./errors.js";
import { macrosForGrams, scaleMacros, sumMacros, tryMacrosForGrams, withSearchNutrients } from "./nutrients.js";

function nutrient(id: number, number: string, name: string, amount: number, unitName = "G"): FoodNutrient {
  return { amount, nutrient: { id, number, name, unitName } };
}

function food(nutrients: FoodNutrient[]): FoodItem {
  return {
    fdcId: 1,
    dataType: "SR Legacy",
    description: "Test food",
    foodNutrients: nutrients,
  };
}

const bananaNutrients: FoodNutrient[] = [
  nutrient(1008, "208", "Energy", 89, "KCAL"),
  nutrient(1003, "203", "Protein", 1.1),
  nutrient(1004, "204", "Total lipid (fat)", 0.3),
  nutrient(1005, "205", "Carbohydrate, by difference", 22.8),
  nutrient(1079, "291", "Fiber, total dietary", 2.6),
];

describe("macrosForGrams", () => {
  it("returns per-100g values at 100 grams", () => {
    expect(macrosForGrams(food(bananaNutrients), 100)).toEqual({
      caloriesKcal: 89,
      proteinG: 1.1,
      fatG: 0.3,
      carbG: 22.8,
      fiberG: 2.6,
    });
  });

  it("scales to 50 grams", () => {
    expect(macrosForGrams(food(bananaNutrients), 50)).toEqual({
      caloriesKcal: 45,
      proteinG: 0.6,
      fatG: 0.2,
      carbG: 11.4,
      fiberG: 1.3,
    });
  });

  it("converts kJ energy to kcal", () => {
    const macros = macrosForGrams(
      food([
        nutrient(1062, "268", "Energy", 418.4, "kJ"),
        nutrient(1003, "203", "Protein", 0),
        nutrient(1004, "204", "Total lipid (fat)", 0),
        nutrient(1005, "205", "Carbohydrate, by difference", 0),
      ]),
      100,
    );
    expect(macros.caloriesKcal).toBe(100);
  });

  it("treats missing fiber as 0", () => {
    const macros = macrosForGrams(
      food([
        nutrient(1008, "208", "Energy", 50, "KCAL"),
        nutrient(1003, "203", "Protein", 1),
        nutrient(1004, "204", "Total lipid (fat)", 1),
        nutrient(1005, "205", "Carbohydrate, by difference", 10),
      ]),
      100,
    );
    expect(macros.fiberG).toBe(0);
  });

  it("reads abridged number/name/amount nutrients", () => {
    const macros = macrosForGrams(
      {
        fdcId: 2742717,
        dataType: "Branded",
        description: "Coca-Cola Zero Sugar Can, 12 fl oz",
        foodNutrients: [
          { number: "208", name: "Energy", amount: 0, unitName: "KCAL" },
          { number: "203", name: "Protein", amount: 0, unitName: "G" },
          { number: "204", name: "Total lipid (fat)", amount: 0, unitName: "G" },
          { number: "205", name: "Carbohydrate, by difference", amount: 0, unitName: "G" },
        ],
      },
      355,
    );
    expect(macros).toEqual({ caloriesKcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0 });
  });

  it("does not treat FoodNutrient row ids as nutrient ids", () => {
    const gdsn = {
      fdcId: 2742717,
      dataType: "Branded",
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      servingSize: 355,
      servingSizeUnit: "MLT",
      foodNutrients: [
        { type: "FoodNutrient", id: 34890924, amount: 0 },
        { type: "FoodNutrient", id: 34890931, amount: 11 },
      ],
      labelNutrients: {},
    } as FoodItem;
    expect(tryMacrosForGrams(gdsn, 355)).toBeUndefined();
    expect(() => macrosForGrams(gdsn, 355)).toThrow(FoodLogMatchError);
  });

  it("uses search-hit nutrients when the detail payload has no nutrient identity", () => {
    const gdsn = {
      fdcId: 2742717,
      dataType: "Branded",
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      servingSize: 355,
      servingSizeUnit: "MLT",
      foodNutrients: [{ type: "FoodNutrient", id: 34890924, amount: 0 }],
      labelNutrients: {},
    } as FoodItem;
    const merged = withSearchNutrients(gdsn, {
      fdcId: 2742717,
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      foodNutrients: [
        { nutrientId: 1008, nutrientNumber: "208", nutrientName: "Energy", unitName: "KCAL", value: 0 },
        { nutrientId: 1003, nutrientNumber: "203", nutrientName: "Protein", unitName: "G", value: 0 },
        { nutrientId: 1004, nutrientNumber: "204", nutrientName: "Total lipid (fat)", unitName: "G", value: 0 },
        { nutrientId: 1005, nutrientNumber: "205", nutrientName: "Carbohydrate, by difference", unitName: "G", value: 0 },
      ],
    });
    expect(macrosForGrams(merged, 355)).toEqual({
      caloriesKcal: 0,
      proteinG: 0,
      fatG: 0,
      carbG: 0,
      fiberG: 0,
    });
  });
});

describe("sumMacros", () => {
  it("adds component macros", () => {
    const a = scaleMacros(
      { caloriesKcal: 100, proteinG: 2, fatG: 1, carbG: 20, fiberG: 3 },
      1,
    );
    const b = scaleMacros(
      { caloriesKcal: 50, proteinG: 8, fatG: 5, carbG: 6, fiberG: 0 },
      1,
    );
    expect(sumMacros([a, b])).toEqual({
      caloriesKcal: 150,
      proteinG: 10,
      fatG: 6,
      carbG: 26,
      fiberG: 3,
    });
  });
});
