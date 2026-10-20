import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { serializeMeal } from "../web/serialize.js";
import { eatenMacros, servingsOf } from "./servings.js";
import type { FoodLogEntry, FoodLogMacros } from "./types.js";

const macros: FoodLogMacros = { caloriesKcal: 100, proteinG: 2, fatG: 3, carbG: 10, fiberG: 1 };

function meal(servings?: number): FoodLogEntry {
  return {
    _id: new ObjectId(),
    eatenAt: new Date("2026-10-20T15:00:00Z"),
    createdAt: new Date("2026-10-20T15:00:00Z"),
    query: "peanut m&ms",
    description: "Peanut M&M's (1 serving (1.74 oz))",
    ...(servings === undefined ? {} : { servings }),
    macros,
    items: [
      {
        name: "Peanut M&M's",
        fdcId: 1,
        description: "CANDY",
        dataType: "Branded",
        grams: 49,
        servingDescription: "1 serving (1.74 oz)",
        macros,
      },
    ],
  };
}

describe("servings", () => {
  it("treats a missing count as one portion", () => {
    expect(servingsOf({})).toBe(1);
    expect(eatenMacros(meal()).caloriesKcal).toBe(100);
  });

  it("scales the presented meal by the stored count", () => {
    const json = serializeMeal(meal(2));
    expect(json.servings).toBe(2);
    expect(json.macros.caloriesKcal).toBe(200);
    expect(json.items[0]?.grams).toBe(98);
    expect(json.items[0]?.macros.proteinG).toBe(4);
  });
});
