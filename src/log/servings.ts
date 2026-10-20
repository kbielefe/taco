import { scaleMacros } from "./nutrients.js";
import type { FoodLogEntry, FoodLogItem, FoodLogMacros } from "./types.js";

export const MAX_SERVINGS = 24;

export function servingsOf(entry: { servings?: number }): number {
  const count = entry.servings;
  if (typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= MAX_SERVINGS) {
    return count;
  }
  return 1;
}

export function scaleItem(item: FoodLogItem, factor: number): FoodLogItem {
  if (factor === 1) {
    return item;
  }
  return {
    ...item,
    grams: Math.round(item.grams * factor * 10) / 10,
    macros: scaleMacros(item.macros, factor),
  };
}

export function eatenMacros(entry: Pick<FoodLogEntry, "macros" | "servings">): FoodLogMacros {
  return scaleMacros(entry.macros, servingsOf(entry));
}
