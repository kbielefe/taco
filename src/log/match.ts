import { z } from "zod";
import type { SearchResultFood } from "../fdc/types.js";
import { gramsFromAmount } from "./nutrients.js";
import type { MatchCandidate, SelectMatchInput } from "./types.js";

export const MIN_GRAMS = 1;
export const MAX_GRAMS = 5000;

export const SelectedMatchSchema = z.object({
  fdcId: z.number().int().positive(),
  grams: z.number().positive(),
  servingDescription: z.string().min(1),
});

export const MATCH_SYSTEM_PROMPT = `You pick the closest USDA FoodData Central match and a typical serving in grams.

Rules:
- fdcId MUST be one of the candidate ids.
- Prefer branded rows when a brand was named.
- Prefer generic Foundation/SR Legacy/Survey rows for whole foods (for example "Bananas, raw", not banana chips).
- Prefer prepared Survey or Branded foods for dishes, not a single raw ingredient.
- grams is the TOTAL grams for this log item after applying quantity.
- Use suggestedGrams or listed portions when they fit the servingHint.
- If nothing else is available, estimate a typical edible gram weight.
- servingDescription is a short household phrase (for example "1 cup", "1 medium banana").`;

export function compactSearchCandidate(food: SearchResultFood, quantity: number): MatchCandidate {
  const portions = portionsFromSearchFood(food);
  const servingGrams = food.servingSize !== undefined ? gramsFromAmount(food.servingSize, food.servingSizeUnit) : undefined;
  const suggestedGrams =
    servingGrams !== undefined
      ? servingGrams * quantity
      : portions[0]
        ? portions[0].grams * quantity
        : undefined;

  return {
    fdcId: food.fdcId,
    description: food.description,
    dataType: food.dataType,
    brandOwner: food.brandOwner,
    score: food.score,
    servingSize: food.servingSize,
    servingSizeUnit: food.servingSizeUnit,
    householdServingFullText: food.householdServingFullText,
    portions,
    suggestedGrams,
  };
}

export function buildMatchUserPrompt(input: SelectMatchInput): string {
  return JSON.stringify(
    {
      mealQuery: input.mealQuery,
      item: input.item,
      candidates: input.candidates,
    },
    null,
    2,
  );
}

export function clampGrams(grams: number): number {
  if (!Number.isFinite(grams) || grams <= 0) {
    return MIN_GRAMS;
  }
  return Math.min(MAX_GRAMS, Math.max(MIN_GRAMS, grams));
}

export function candidateIds(candidates: MatchCandidate[]): Set<number> {
  return new Set(candidates.map((candidate) => candidate.fdcId));
}

function portionsFromSearchFood(food: SearchResultFood): { description: string; grams: number }[] {
  const measures = food.foodMeasures;
  if (!Array.isArray(measures)) {
    return [];
  }
  const portions: { description: string; grams: number }[] = [];
  for (const measure of measures) {
    if (!measure || typeof measure !== "object") {
      continue;
    }
    const rec = measure as Record<string, unknown>;
    const grams = typeof rec.gramWeight === "number" ? rec.gramWeight : undefined;
    if (grams === undefined || grams <= 0) {
      continue;
    }
    const description =
      stringField(rec, "disseminationText") ??
      stringField(rec, "portionDescription") ??
      stringField(rec, "modifier") ??
      `${grams} g`;
    portions.push({ description, grams });
    if (portions.length >= 6) {
      break;
    }
  }
  return portions;
}

function stringField(rec: Record<string, unknown>, key: string): string | undefined {
  const value = rec[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
