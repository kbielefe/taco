import { z } from "zod";
import { FDC_DATA_TYPES } from "../fdc/types.js";
import type { ParsedMeal } from "./types.js";

const FdcDataTypeSchema = z.enum(FDC_DATA_TYPES);

export const ParsedFoodItemSchema = z.object({
  name: z.string().min(1),
  searchQuery: z.string().min(1),
  fallbackQuery: z.string().nullable(),
  brandOwner: z.string().nullable(),
  dataTypes: z.array(FdcDataTypeSchema).nullable(),
  servingHint: z.string().min(1),
  quantity: z.number().positive(),
});

export const ParsedMealSchema = z.object({
  items: z.array(ParsedFoodItemSchema).min(1).max(12),
});

export const PARSE_SYSTEM_PROMPT = `You split a food diary entry into USDA FoodData Central search items.

Rules:
- Distinct foods eaten together (for example "Cheerios and milk") become separate items.
- A branded product (for example "Jimmy Dean egg cup") is ONE item. Set brandOwner and dataTypes to ["Branded"].
- A prepared dish (for example "Apple crumble cake") is ONE item, not a recipe of flour/sugar/butter. Prefer dataTypes ["Survey (FNDDS)", "Branded"].
- A simple whole food (for example "banana") is ONE item. Prefer dataTypes ["Foundation", "SR Legacy", "Survey (FNDDS)"].
- Do not invent ingredients that were not named.
- quantity is how many of that item were eaten (default 1). "2 bananas" means quantity 2.
- searchQuery is a short FDC search string.
- fallbackQuery is a broader search if the specific one might miss; use null if not needed.
- servingHint is a typical household serving for this log, including quantity.
- brandOwner and dataTypes are null when unknown.`;

export function normalizeParsedMeal(parsed: z.infer<typeof ParsedMealSchema>): ParsedMeal {
  return {
    items: parsed.items.map((item) => {
      const fallbackQuery = emptyToUndefined(item.fallbackQuery);
      const brandOwner = emptyToUndefined(item.brandOwner);
      const dataTypes = item.dataTypes && item.dataTypes.length > 0 ? item.dataTypes : undefined;
      return {
        name: item.name.trim(),
        searchQuery: item.searchQuery.trim(),
        ...(fallbackQuery ? { fallbackQuery } : {}),
        ...(brandOwner ? { brandOwner } : {}),
        ...(dataTypes ? { dataTypes } : {}),
        servingHint: item.servingHint.trim(),
        quantity: item.quantity,
      };
    }),
  };
}

function emptyToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
