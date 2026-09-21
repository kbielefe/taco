export { classifyFood, foodKey, metabolizableKcal } from "./category.js";
export { formulaPerDay } from "./formula.js";
export {
  clipFactor,
  correctedMacros,
  correctionFor,
  fitEnergyWindows,
  leaveOneOut,
  predictStorage,
} from "./fit.js";
export type { CategoryEstimate, CorrectionFit, FactorEstimate, FoodEstimate, ItemCorrection, ModelScore } from "./fit.js";
export {
  CATEGORIES,
  FACTOR_CLIP_HIGH,
  FACTOR_CLIP_LOW,
  MAX_MISSING_DAYS,
  SIGMA_FLOOR_KCAL,
} from "./types.js";
export type {
  Category,
  CorrectionItem,
  EnergyWindow,
  FitMode,
  LoggedMeal,
} from "./types.js";
export { buildEnergyWindows, localDayKey } from "./windows.js";
