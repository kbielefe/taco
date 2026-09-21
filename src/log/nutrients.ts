import type { AbridgedFoodNutrient, FoodItem, FoodNutrient, LabelNutrients, SearchFoodNutrient, SearchResultFood } from "../fdc/types.js";
import { FoodLogMatchError } from "./errors.js";
import type { FoodLogMacros } from "./types.js";

const ENERGY_KCAL_IDS = new Set([1008, 2047, 2048]);
const ENERGY_KCAL_NUMBERS = new Set(["208", "957", "958"]);
const ENERGY_KJ_IDS = new Set([1062]);
const ENERGY_KJ_NUMBERS = new Set(["268"]);
const PROTEIN_IDS = new Set([1003]);
const PROTEIN_NUMBERS = new Set(["203"]);
const FAT_IDS = new Set([1004]);
const FAT_NUMBERS = new Set(["204"]);
const CARB_IDS = new Set([1005]);
const CARB_NUMBERS = new Set(["205"]);
const FIBER_IDS = new Set([1079]);
const FIBER_NUMBERS = new Set(["291"]);
const KJ_PER_KCAL = 4.184;

interface NutrientReading {
  id?: number;
  number?: string;
  name?: string;
  amount?: number;
  unit?: string;
}

export function macrosForGrams(food: FoodItem, grams: number): FoodLogMacros {
  const macros = tryMacrosForGrams(food, grams);
  if (macros) {
    return macros;
  }
  throw new FoodLogMatchError(`No nutrient data for FDC ${food.fdcId} (${food.description})`, {
    query: food.description,
  });
}

export function tryMacrosForGrams(food: FoodItem, grams: number): FoodLogMacros | undefined {
  const per100 = macrosFromFoodNutrients(food);
  if (per100) {
    return scaleMacros(per100, grams / 100);
  }

  const label = macrosFromLabelNutrients(food);
  const servingGrams = brandedServingGrams(food);
  if (label && servingGrams && servingGrams > 0) {
    return scaleMacros(label, grams / servingGrams);
  }
  return undefined;
}

/** Some branded `/food/{id}` payloads omit nutrient identity; search hits still have it. */
export function withSearchNutrients(food: FoodItem, search: SearchResultFood): FoodItem {
  if (!search.foodNutrients || search.foodNutrients.length === 0) {
    return food;
  }
  return {
    ...food,
    foodNutrients: search.foodNutrients.map(searchNutrientToFoodNutrient),
  };
}

function searchNutrientToFoodNutrient(nutrient: SearchFoodNutrient): FoodNutrient {
  return {
    amount: nutrient.value,
    nutrient: {
      id: nutrient.nutrientId,
      number: nutrient.nutrientNumber,
      name: nutrient.nutrientName,
      unitName: nutrient.unitName,
    },
  };
}

export function sumMacros(items: FoodLogMacros[]): FoodLogMacros {
  return roundMacros(
    items.reduce(
      (acc, item) => ({
        caloriesKcal: acc.caloriesKcal + item.caloriesKcal,
        proteinG: acc.proteinG + item.proteinG,
        fatG: acc.fatG + item.fatG,
        carbG: acc.carbG + item.carbG,
        fiberG: acc.fiberG + item.fiberG,
      }),
      { caloriesKcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0 },
    ),
  );
}

export function scaleMacros(macros: FoodLogMacros, factor: number): FoodLogMacros {
  return roundMacros({
    caloriesKcal: macros.caloriesKcal * factor,
    proteinG: macros.proteinG * factor,
    fatG: macros.fatG * factor,
    carbG: macros.carbG * factor,
    fiberG: macros.fiberG * factor,
  });
}

export function roundMacros(macros: FoodLogMacros): FoodLogMacros {
  return {
    caloriesKcal: Math.round(macros.caloriesKcal),
    proteinG: round1(macros.proteinG),
    fatG: round1(macros.fatG),
    carbG: round1(macros.carbG),
    fiberG: round1(macros.fiberG),
  };
}

export function brandedServingGrams(food: FoodItem): number | undefined {
  if (!("servingSize" in food) || food.servingSize === undefined) {
    return undefined;
  }
  return gramsFromAmount(food.servingSize, "servingSizeUnit" in food ? food.servingSizeUnit : undefined);
}

export function gramsFromAmount(amount: number, unit?: string): number | undefined {
  if (!Number.isFinite(amount) || amount <= 0) {
    return undefined;
  }
  const normalized = (unit ?? "g").trim().toLowerCase();
  if (normalized === "" || normalized === "g" || normalized === "grm" || normalized === "gram" || normalized === "grams") {
    return amount;
  }
  if (normalized === "ml" || normalized === "mlt" || normalized === "milliliter" || normalized === "milliliters") {
    return amount;
  }
  if (normalized === "oz" || normalized === "onz") {
    return amount * 28.3495;
  }
  if (normalized === "lb" || normalized === "lbr") {
    return amount * 453.592;
  }
  if (normalized === "kg") {
    return amount * 1000;
  }
  return undefined;
}

function macrosFromFoodNutrients(food: FoodItem): FoodLogMacros | undefined {
  const readings = readingsFromFood(food);
  if (readings.length === 0) {
    return undefined;
  }

  const caloriesKcal = energyKcal(readings);
  const proteinG = amountOf(readings, PROTEIN_IDS, PROTEIN_NUMBERS) ?? 0;
  const fatG = amountOf(readings, FAT_IDS, FAT_NUMBERS) ?? 0;
  const carbG = amountOf(readings, CARB_IDS, CARB_NUMBERS) ?? 0;
  const fiberG = amountOf(readings, FIBER_IDS, FIBER_NUMBERS) ?? 0;

  if (caloriesKcal === undefined && proteinG === 0 && fatG === 0 && carbG === 0) {
    return undefined;
  }

  return {
    caloriesKcal: caloriesKcal ?? 0,
    proteinG,
    fatG,
    carbG,
    fiberG,
  };
}

function macrosFromLabelNutrients(food: FoodItem): FoodLogMacros | undefined {
  if (!("labelNutrients" in food) || !food.labelNutrients) {
    return undefined;
  }
  const label = food.labelNutrients as LabelNutrients;
  const caloriesKcal = label.calories?.value;
  const proteinG = label.protein?.value;
  const fatG = label.fat?.value;
  const carbG = label.carbohydrates?.value;
  const fiberG = label.fiber?.value ?? 0;
  if (caloriesKcal === undefined && proteinG === undefined && fatG === undefined && carbG === undefined) {
    return undefined;
  }
  return {
    caloriesKcal: caloriesKcal ?? 0,
    proteinG: proteinG ?? 0,
    fatG: fatG ?? 0,
    carbG: carbG ?? 0,
    fiberG,
  };
}

function energyKcal(readings: NutrientReading[]): number | undefined {
  const kcal = amountOf(readings, ENERGY_KCAL_IDS, ENERGY_KCAL_NUMBERS, (unit) => unit !== "kj");
  if (kcal !== undefined) {
    return kcal;
  }
  const kj = amountOf(readings, ENERGY_KJ_IDS, ENERGY_KJ_NUMBERS);
  if (kj !== undefined) {
    return kj / KJ_PER_KCAL;
  }
  const energyByName = readings.find(
    (reading) => reading.name && /^energy\b/i.test(reading.name) && reading.amount !== undefined,
  );
  if (energyByName?.amount !== undefined) {
    return normalizeUnit(energyByName.unit) === "kj" ? energyByName.amount / KJ_PER_KCAL : energyByName.amount;
  }
  return undefined;
}

function amountOf(
  readings: NutrientReading[],
  ids: Set<number>,
  numbers: Set<string>,
  unitOk?: (unit: string) => boolean,
): number | undefined {
  return firstMatch(readings, ids, numbers, unitOk)?.amount;
}

function firstMatch(
  readings: NutrientReading[],
  ids: Set<number>,
  numbers: Set<string>,
  unitOk?: (unit: string) => boolean,
): NutrientReading | undefined {
  return readings.find((reading) => {
    if (reading.amount === undefined || Number.isNaN(reading.amount)) {
      return false;
    }
    if (unitOk && !unitOk(normalizeUnit(reading.unit))) {
      return false;
    }
    if (reading.id !== undefined && ids.has(reading.id)) {
      return true;
    }
    if (reading.number !== undefined && numbers.has(String(reading.number))) {
      return true;
    }
    return false;
  });
}

function readingsFromFood(food: FoodItem): NutrientReading[] {
  const nutrients = "foodNutrients" in food ? (food.foodNutrients ?? []) : [];
  return nutrients.map((nutrient) => readingFromNutrient(nutrient));
}

function readingFromNutrient(
  nutrient: FoodNutrient | AbridgedFoodNutrient | SearchFoodNutrient,
): NutrientReading {
  const rec = nutrient as FoodNutrient & AbridgedFoodNutrient & SearchFoodNutrient;
  const nested = rec.nutrient;
  return {
    // `FoodNutrient.id` is the row id, not the nutrient id. Never use it as nutrient.id.
    id: nested?.id ?? rec.nutrientId,
    number:
      nested?.number !== undefined
        ? String(nested.number)
        : rec.number !== undefined
          ? String(rec.number)
          : rec.nutrientNumber !== undefined
            ? String(rec.nutrientNumber)
            : undefined,
    name: nested?.name ?? rec.name ?? rec.nutrientName,
    amount: rec.amount ?? rec.value,
    unit: nested?.unitName ?? rec.unitName,
  };
}

function normalizeUnit(unit?: string): string {
  return (unit ?? "").trim().toLowerCase();
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
