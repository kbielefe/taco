import type { FoodLogMacros } from "../log/types.js";
import { CATEGORIES, type Category, type CorrectionItem } from "./types.js";

const TEF_PROTEIN = 0.25;
const TEF_CARB = 0.075;
const TEF_FAT = 0.02;
const MAX_TEF = 0.5;

const CONTAINER =
  /\b(?:cans?|bottles?|bars?|pouches?|packets?|packages?|packs?|cartons?|sticks?|containers?|bags?|cups?|tubs?|jars?|boxes)\b/i;
const COUNT_SERVING = /^\s*\d+(?:\.\d+)?(?:\s+(?:extra[\s-]+large|large|medium|small))?\s+(\S+)/i;
const NOT_A_COUNT =
  /^(?:grams?|g|oz|ounces?|ml|mls?|l|cups?|tbsp|tablespoons?|tsp|teaspoons?|lbs?|pounds?|kg|kgs?|fl|floz|liters?|litres?|quarts?|pints?|gallons?|bowls?|plates?|servings?|portions?|slices?)$/i;
const DISH =
  /\b(?:bowls?|sandwiches|sandwich|burgers?|pizzas?|salads?|casseroles?|burritos?|tacos?|curries|curry|soups?|stews?|pastas?|stir-fry|stir fry|quesadillas?|wraps?|enchiladas?|lasagnas?|platters?|nuggets?|wings?|entrees?|entrées?)\b/i;
const DRINK =
  /\b(?:coffees?|teas?|waters?|sodas?|juices?|milks?|beers?|wines?|lattes?|colas?|cokes?|drinks?|beverages?|smoothies?|shakes?|kombuchas?|lemonades?|ciders?|espressos?|cappuccinos?|mochas?|sprites?|pepsis?)\b/i;

export function foodKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function groupId(category: Category, key: string): string {
  return `${category}\t${key}`;
}

export function metabolizableKcal(macros: FoodLogMacros): number {
  const kcal = macros.caloriesKcal;
  if (!Number.isFinite(kcal) || kcal <= 0) {
    return 0;
  }
  const proteinKcal = macros.proteinG * 4;
  const carbKcal = macros.carbG * 4;
  const fatKcal = macros.fatG * 9;
  const macroKcal = proteinKcal + carbKcal + fatKcal;
  if (macroKcal <= 0) {
    return kcal;
  }
  const tef = (TEF_PROTEIN * proteinKcal + TEF_CARB * carbKcal + TEF_FAT * fatKcal) / macroKcal;
  const fraction = Math.min(MAX_TEF, Math.max(0, tef));
  return kcal * (1 - fraction);
}

export function classifyFood(item: CorrectionItem): Category {
  if (isBrandedPackage(item)) {
    return "branded";
  }
  if (isDiscreteWholeFood(item)) {
    return "discrete";
  }
  if (isEnergyDense(item)) {
    return "energy";
  }
  if (isMixedDish(item)) {
    return "mixed";
  }
  if (DRINK.test(item.name)) {
    return "beverage";
  }
  return "other";
}

export function categoryIndex(category: Category): number {
  return CATEGORIES.indexOf(category);
}

function isBrandedPackage(item: CorrectionItem): boolean {
  return item.dataType.trim().toLowerCase() === "branded" && CONTAINER.test(item.servingDescription);
}

function isDiscreteWholeFood(item: CorrectionItem): boolean {
  const dataType = item.dataType.trim().toLowerCase();
  if (dataType !== "foundation" && dataType !== "sr legacy") {
    return false;
  }
  if (DISH.test(item.name)) {
    return false;
  }
  const match = COUNT_SERVING.exec(item.servingDescription);
  const word = match?.[1];
  if (!word || NOT_A_COUNT.test(word)) {
    return false;
  }
  return true;
}

function isEnergyDense(item: CorrectionItem): boolean {
  const kcal = item.macros.caloriesKcal;
  if (!Number.isFinite(kcal) || kcal <= 0) {
    return false;
  }
  if (item.grams > 0 && kcal / item.grams >= 4) {
    return true;
  }
  return (9 * item.macros.fatG) / kcal >= 0.7;
}

function isMixedDish(item: CorrectionItem): boolean {
  if (/survey|fndds/i.test(item.dataType)) {
    return true;
  }
  return DISH.test(item.name);
}
