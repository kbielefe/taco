import type { FoodLogEntry, FoodLogMacros } from "../log/types.js";

export interface MealJson {
  id: string;
  eatenAt: string;
  createdAt: string;
  query: string;
  description: string;
  macros: FoodLogMacros;
  items: FoodLogEntry["items"];
}

export function serializeMeal(entry: FoodLogEntry): MealJson {
  return {
    id: entry._id.toHexString(),
    eatenAt: entry.eatenAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    query: entry.query,
    description: entry.description,
    macros: entry.macros,
    items: entry.items,
  };
}

export function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}
