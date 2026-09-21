import type { FoodLogMacros } from "../log/types.js";

export const CATEGORIES = ["branded", "discrete", "energy", "mixed", "beverage", "other"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SIGMA_FLOOR_KCAL = 300;
export const MIN_SPAN_DAYS = 5;
export const MAX_SPAN_DAYS = 14;
export const TARGET_SPAN_DAYS = 7;
export const MAX_MISSING_DAYS = 1;
export const FOOD_MIN_WINDOWS = 4;
export const FOOD_SHARE_SD_MIN = 0.05;
export const FOOD_CATEGORY_FRACTION_SD_MIN = 0.08;
export const FACTOR_CLIP_LOW = 0.7;
export const FACTOR_CLIP_HIGH = 1.5;
export const Z90 = 1.6448536269514722;

export const PRIOR_SD_GLOBAL = 0.05;
export const PRIOR_SD_CATEGORY = 0.15;
export const PRIOR_SD_FOOD = 0.1;
export const PRIOR_SD_EXPENDITURE = 0.1;

export type FitMode = "hierarchy" | "global" | "null";

export interface CorrectionItem {
  name: string;
  dataType: string;
  grams: number;
  servingDescription: string;
  macros: FoodLogMacros;
}

export interface LoggedMeal {
  eatenAt: Date;
  items: CorrectionItem[];
}

export interface EnergyGroup {
  id: string;
  category: Category;
  foodKey: string;
  metKcal: number;
}

export interface EnergyWindow {
  startDay: string;
  endDay: string;
  days: number;
  storagePerDay: number;
  sigma: number;
  formulaPerDay: number;
  loggedDays: number;
  missingDays: number;
  groups: EnergyGroup[];
}
