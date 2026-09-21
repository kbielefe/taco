import { z } from "zod";
import type { FdcDataType, SearchResultFood } from "../fdc/types.js";
import { gramsFromAmount } from "./nutrients.js";
import { uniqueSearchQueries } from "./parse.js";
import type { MatchCandidate, ParsedFoodItem, SelectMatchInput } from "./types.js";

export const MIN_GRAMS = 1;
export const MAX_GRAMS = 5000;
export const SEARCH_CANDIDATE_LIMIT = 12;

export const SelectedMatchSchema = z.object({
  fdcId: z.number().int().positive(),
  grams: z.number().positive(),
  servingDescription: z.string().min(1),
});

export const MATCH_SYSTEM_PROMPT = `You pick the closest USDA FoodData Central match and a typical serving in grams.

Rules:
- fdcId MUST be one of the candidate ids.
- Candidates are already fused from several FDC searches and ordered most relevant first. Prefer an earlier candidate unless a later one is clearly a better food match.
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

export function fusedSearchFoods(
  resultLists: readonly SearchResultFood[][],
  item: ParsedFoodItem,
  limit = SEARCH_CANDIDATE_LIMIT,
): SearchResultFood[] {
  const merged = new Map<number, { food: SearchResultFood; hitCount: number }>();
  for (const foods of resultLists) {
    for (const food of foods) {
      const existing = merged.get(food.fdcId);
      if (!existing) {
        merged.set(food.fdcId, { food, hitCount: 1 });
        continue;
      }
      existing.hitCount += 1;
      if ((food.score ?? 0) > (existing.food.score ?? 0)) {
        existing.food = food;
      }
    }
  }

  const queryCount = Math.max(resultLists.length, 1);
  return [...merged.values()]
    .map((entry) => ({
      food: entry.food,
      rank: relevanceScore(entry.food, item, entry.hitCount, queryCount),
    }))
    .sort((a, b) => b.rank - a.rank || a.food.fdcId - b.food.fdcId)
    .slice(0, limit)
    .map((entry) => entry.food);
}

function relevanceScore(food: SearchResultFood, item: ParsedFoodItem, hitCount: number, queryCount: number): number {
  const haystack = [food.description, food.brandOwner, food.brandName, food.additionalDescriptions]
    .filter((part): part is string => typeof part === "string" && part.trim() !== "")
    .join(" ");
  const haystackLower = haystack.toLowerCase();
  const haystackTokens = tokenize(haystack);
  const queries = uniqueSearchQueries([item.name, ...item.searchQueries]);

  let lexical = 0;
  for (const query of queries) {
    const queryTokens = tokenize(query);
    const coverage =
      queryTokens.size === 0
        ? 0
        : [...queryTokens].filter((token) => haystackTokens.has(token)).length / queryTokens.size;
    const phrase = query.length >= 3 && haystackLower.includes(query.toLowerCase()) ? 1 : 0;
    lexical = Math.max(lexical, coverage + phrase);
  }

  let brand = 0;
  if (item.brandOwner && food.brandOwner) {
    const want = item.brandOwner.toLowerCase();
    const got = food.brandOwner.toLowerCase();
    if (got.includes(want) || want.includes(got)) {
      brand = 1;
    }
  }

  let type = 0;
  if (item.dataTypes && item.dataTypes.length > 0 && food.dataType) {
    type = item.dataTypes.includes(food.dataType as FdcDataType) ? 1 : 0;
  }

  const consensus = hitCount / queryCount;
  const fdc = typeof food.score === "number" ? food.score / 1000 : 0;
  return lexical * 4 + brand * 1.5 + type * 0.75 + consensus + fdc * 0.1;
}

const STOP_TOKENS = new Set(["a", "an", "the", "and", "or", "of", "with", "in", "for", "to", "raw"]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const part of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (part.length < 2 || STOP_TOKENS.has(part)) {
      continue;
    }
    tokens.add(part);
  }
  return tokens;
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
