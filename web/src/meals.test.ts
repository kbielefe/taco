/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from "vitest";
import type { Meal } from "./api.js";
import { renderMeal } from "./meals.js";

const macros = { caloriesKcal: 400, proteinG: 8, fatG: 10, carbG: 60, fiberG: 2 };

function friedRice(servings: number): Meal {
  return {
    id: "meal-1",
    eatenAt: "2026-10-20T18:00:00.000Z",
    createdAt: "2026-10-20T18:00:00.000Z",
    query: "fried rice",
    description: "fried rice (1 cup)",
    servings,
    macros,
    items: [
      {
        name: "fried rice",
        fdcId: 1,
        description: "Rice, fried",
        dataType: "Survey (FNDDS)",
        grams: 200,
        servingDescription: "1 cup",
        macros,
      },
    ],
  };
}

describe("renderMeal", () => {
  it("shows the food name and the logged quantity", () => {
    const row = renderMeal(friedRice(2), () => {}, () => {}, false, () => {});
    expect(row.querySelector(".log-title")?.textContent).toBe("Fried Rice");
    expect(row.querySelector(".stepper span")?.textContent).toBe("2");
  });
});
