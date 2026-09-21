import { z } from "zod";
import { FDC_DATA_TYPES } from "../fdc/types.js";
import type { ParsedFoodItem, ParsedMeal } from "./types.js";

const FdcDataTypeSchema = z.enum(FDC_DATA_TYPES);

export const MAX_SEARCH_QUERIES = 5;

export const ParsedFoodItemSchema = z.object({
  name: z.string().min(1),
  searchQueries: z.array(z.string().min(1)).min(1).max(MAX_SEARCH_QUERIES),
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
- searchQueries is 3 to 5 distinct short FDC search strings for this item. Cover the user's wording or nickname, the catalog name FDC is likely to index (for example "coke zero" → "Coca-Cola Zero Sugar", "diet coke" → "Diet Coke"), a generic product type, and useful synonyms or alternate brand spellings. Do not pad with near-duplicates. Never return only one query when a nickname and a catalog name both exist.
- servingHint is a typical household serving for this log, including quantity.
- brandOwner and dataTypes are null when unknown.`;

export function normalizeParsedMeal(parsed: z.infer<typeof ParsedMealSchema>): ParsedMeal {
  return {
    items: parsed.items.map((item) => {
      const name = item.name.trim();
      const brandOwner = emptyToUndefined(item.brandOwner);
      const dataTypes = item.dataTypes && item.dataTypes.length > 0 ? item.dataTypes : undefined;
      return {
        name,
        searchQueries: searchQueriesForItem({
          name,
          searchQueries: item.searchQueries,
          ...(brandOwner ? { brandOwner } : {}),
        }),
        ...(brandOwner ? { brandOwner } : {}),
        ...(dataTypes ? { dataTypes } : {}),
        servingHint: item.servingHint.trim(),
        quantity: item.quantity,
      };
    }),
  };
}

export function searchQueriesForItem(item: Pick<ParsedFoodItem, "name" | "searchQueries" | "brandOwner">): string[] {
  const extras = [item.name];
  if (item.brandOwner) {
    extras.push(`${item.brandOwner} ${item.name}`);
  }
  const queries = uniqueSearchQueries([...item.searchQueries, ...extras]);
  return queries.length > 0 ? queries : [item.name.trim() || "food"];
}

export function uniqueSearchQueries(queries: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const query of queries) {
    const trimmed = query.trim().replace(/\s+/g, " ");
    if (trimmed === "") {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(trimmed);
    if (unique.length >= MAX_SEARCH_QUERIES) {
      break;
    }
  }
  return unique;
}

function emptyToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
