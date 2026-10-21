import { MAX_SERVINGS } from "./servings.js";

const MEASURE =
  /^(?:grams?|g|oz|ounces?|ml|mls?|l|cups?|tbsp|tablespoons?|tsp|teaspoons?|lbs?|pounds?|kg|kgs?|fl|floz|liters?|litres?|quarts?|pints?|gallons?|bowls?|plates?|servings?|portions?|slices?)$/i;

const LEADING_COUNT = /^(\d+)(?![.\d/%])(?:\s*[x×])?\s+(\S(?:.*\S)?)$/;

const JOIN = /,|&|\+|\/|\band\b|\bwith\b|\bplus\b/i;

export interface LeadingQuantity {
  quantity: number;
  food: string;
}

/** A leading count of a food, such as "2 fried rice" or "2x fried rice". Amounts like "2 cups of rice" stay put. */
export function splitLeadingQuantity(text: string): LeadingQuantity | undefined {
  const match = LEADING_COUNT.exec(text.trim());
  const count = match?.[1];
  const rest = match?.[2];
  if (!count || !rest) {
    return undefined;
  }
  const quantity = Number(count);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_SERVINGS) {
    return undefined;
  }
  const food = rest.replace(/\s+/g, " ").trim();
  const first = food.split(" ")[0];
  if (!first || MEASURE.test(first)) {
    return undefined;
  }
  return { quantity, food };
}

export function foodPhraseHasJoin(food: string): boolean {
  return JOIN.test(food);
}

export function nameWithoutLeadingQuantity(name: string, quantity: number): { name: string; quantity: number } {
  const counted = splitLeadingQuantity(name);
  if (!counted) {
    return { name, quantity };
  }
  return {
    name: counted.food,
    quantity: quantity === 1 ? counted.quantity : quantity,
  };
}
