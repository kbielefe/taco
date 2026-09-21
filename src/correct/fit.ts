import { scaleMacros } from "../log/nutrients.js";
import type { FoodLogMacros } from "../log/types.js";
import { ADAPTIVE_CLAMP_HIGH, ADAPTIVE_CLAMP_LOW } from "../energy/recommend.js";
import { categoryIndex, classifyFood, foodKey } from "./category.js";
import {
  CATEGORIES,
  FACTOR_CLIP_HIGH,
  FACTOR_CLIP_LOW,
  FOOD_CATEGORY_FRACTION_SD_MIN,
  FOOD_MIN_WINDOWS,
  FOOD_SHARE_SD_MIN,
  PRIOR_SD_CATEGORY,
  PRIOR_SD_EXPENDITURE,
  PRIOR_SD_FOOD,
  PRIOR_SD_GLOBAL,
  Z90,
  type Category,
  type CorrectionItem,
  type EnergyWindow,
  type FitMode,
} from "./types.js";

const U_MIN = Math.log(ADAPTIVE_CLAMP_LOW);
const U_MAX = Math.log(ADAPTIVE_CLAMP_HIGH);

export interface FactorEstimate {
  factor: number;
  low: number;
  high: number;
  applied: number;
  excludesOne: boolean;
}

export interface CategoryEstimate extends FactorEstimate {
  category: Category;
  delta: number;
}

export interface FoodEstimate extends FactorEstimate {
  id: string;
  key: string;
  category: Category;
  delta: number;
}

export interface CorrectionFit {
  fitted: boolean;
  mode: FitMode;
  windowCount: number;
  delta0: number;
  expenditureLog: number;
  expenditureFactor: number;
  expenditureLow: number;
  expenditureHigh: number;
  categories: CategoryEstimate[];
  foods: FoodEstimate[];
  cost: number;
}

export interface ItemCorrection {
  category: Category;
  factor: number;
  raw: number;
  low: number;
  high: number;
  foodSpecific: boolean;
}

export interface ModelScore {
  nullError: number;
  globalError: number;
  hierarchyError: number;
}

interface ParamSpec {
  count: number;
  delta0Index: number;
  uIndex: number;
  categoryIndex: (number | undefined)[];
  foodIds: string[];
  foodParam: Map<string, number>;
  priorSd: number[];
}

export function fitEnergyWindows(windows: EnergyWindow[], mode: FitMode = "hierarchy"): CorrectionFit {
  if (mode === "null" || windows.length === 0) {
    return priorFit(windows.length, mode === "null" ? "null" : mode);
  }
  const spec = parameterSpec(windows, mode);
  const fitted = maximize(windows, spec);
  return fitFromTheta(windows, spec, fitted.theta, fitted.covariance, fitted.cost, mode);
}

export function correctionFor(fit: CorrectionFit, item: CorrectionItem): ItemCorrection {
  const category = classifyFood(item);
  if (item.macros.caloriesKcal <= 0) {
    return { category, factor: 1, raw: 1, low: 1, high: 1, foodSpecific: false };
  }
  const key = foodKey(item.name);
  const food = fit.foods.find((estimate) => estimate.key === key && estimate.category === category);
  if (food?.excludesOne) {
    return {
      category,
      factor: food.applied,
      raw: food.factor,
      low: food.low,
      high: food.high,
      foodSpecific: true,
    };
  }
  const estimate = fit.categories.find((entry) => entry.category === category);
  return {
    category,
    factor: estimate?.applied ?? 1,
    raw: estimate?.factor ?? 1,
    low: estimate?.low ?? 1,
    high: estimate?.high ?? 1,
    foodSpecific: false,
  };
}

export function correctedMacros(item: CorrectionItem, fit: CorrectionFit): FoodLogMacros {
  return scaleMacros(item.macros, correctionFor(fit, item).factor);
}

export function leaveOneOut(windows: EnergyWindow[]): ModelScore {
  if (windows.length < 2) {
    return { nullError: Infinity, globalError: Infinity, hierarchyError: Infinity };
  }
  let nullError = 0;
  let globalError = 0;
  let hierarchyError = 0;
  for (let held = 0; held < windows.length; held += 1) {
    const test = windows[held];
    if (!test) {
      continue;
    }
    const train = windows.filter((_, index) => index !== held);
    nullError += squaredError(test, priorFit(train.length, "null"));
    globalError += squaredError(test, fitEnergyWindows(train, "global"));
    hierarchyError += squaredError(test, fitEnergyWindows(train, "hierarchy"));
  }
  return { nullError, globalError, hierarchyError };
}

export function energyResiduals(
  windows: EnergyWindow[],
  theta: number[],
  mode: FitMode = "hierarchy",
): { residuals: number[]; jacobian: number[][]; cost: number } {
  const spec = parameterSpec(windows, mode);
  if (theta.length !== spec.count) {
    throw new Error(`Expected ${spec.count} parameters, got ${theta.length}.`);
  }
  return evaluate(windows, spec, theta);
}

export function predictStorage(window: EnergyWindow, fit: CorrectionFit): number {
  let intake = 0;
  for (const group of window.groups) {
    const category = fit.categories.find((entry) => entry.category === group.category);
    const food = fit.foods.find((entry) => entry.id === group.id);
    const delta = fit.delta0 + (category?.delta ?? 0) + (food?.delta ?? 0);
    intake += Math.exp(delta) * group.metKcal;
  }
  return intake / window.days - window.formulaPerDay * Math.exp(fit.expenditureLog);
}

function priorFit(windowCount: number, mode: FitMode): CorrectionFit {
  const categories = CATEGORIES.map((category) => categoryEstimate(category, 0, 0, priorCategoryVariance()));
  return {
    fitted: false,
    mode,
    windowCount,
    delta0: 0,
    expenditureLog: 0,
    expenditureFactor: 1,
    expenditureLow: Math.exp(-Z90 * PRIOR_SD_EXPENDITURE),
    expenditureHigh: Math.exp(Z90 * PRIOR_SD_EXPENDITURE),
    categories,
    foods: [],
    cost: 0,
  };
}

function priorCategoryVariance(): number {
  return PRIOR_SD_GLOBAL ** 2 + PRIOR_SD_CATEGORY ** 2;
}

function parameterSpec(windows: EnergyWindow[], mode: FitMode): ParamSpec {
  const foods = mode === "hierarchy" ? [...supportedFoods(windows)].sort() : [];
  const categorySlots = mode === "hierarchy" ? CATEGORIES.length : 0;
  const count = 1 + categorySlots + foods.length + 1;
  const categorySlotsIndex: (number | undefined)[] = CATEGORIES.map((_, index) =>
    mode === "hierarchy" ? 1 + index : undefined,
  );
  const foodParam = new Map<string, number>();
  foods.forEach((id, index) => {
    foodParam.set(id, 1 + categorySlots + index);
  });
  const priorSd = new Array<number>(count).fill(PRIOR_SD_CATEGORY);
  priorSd[0] = PRIOR_SD_GLOBAL;
  for (const index of foodParam.values()) {
    priorSd[index] = PRIOR_SD_FOOD;
  }
  priorSd[count - 1] = PRIOR_SD_EXPENDITURE;
  return {
    count,
    delta0Index: 0,
    uIndex: count - 1,
    categoryIndex: categorySlotsIndex,
    foodIds: foods,
    foodParam,
    priorSd,
  };
}

function supportedFoods(windows: EnergyWindow[]): Set<string> {
  const ids = new Set<string>();
  for (const window of windows) {
    for (const group of window.groups) {
      ids.add(group.id);
    }
  }
  const kept = new Set<string>();
  for (const id of ids) {
    const shares: number[] = [];
    const fractions: number[] = [];
    let present = 0;
    let category: Category | undefined;
    for (const window of windows) {
      const group = window.groups.find((entry) => entry.id === id);
      const met = group?.metKcal ?? 0;
      if (group) {
        category = group.category;
      }
      const total = window.groups.reduce((sum, entry) => sum + entry.metKcal, 0);
      shares.push(total > 0 ? met / total : 0);
      if (met > 0) {
        present += 1;
      }
      if (category) {
        const categoryMet = window.groups
          .filter((entry) => entry.category === category)
          .reduce((sum, entry) => sum + entry.metKcal, 0);
        if (categoryMet > 0) {
          fractions.push(met / categoryMet);
        }
      }
    }
    if (present < FOOD_MIN_WINDOWS || stdev(shares) < FOOD_SHARE_SD_MIN) {
      continue;
    }
    // A food eaten in proportion to its category is the same parameter twice.
    if (stdev(fractions) < FOOD_CATEGORY_FRACTION_SD_MIN) {
      continue;
    }
    kept.add(id);
  }
  return kept;
}

interface Evaluation {
  residuals: number[];
  jacobian: number[][];
  cost: number;
}

function maximize(
  windows: EnergyWindow[],
  spec: ParamSpec,
): { theta: number[]; covariance: number[][]; cost: number } {
  let theta = new Array<number>(spec.count).fill(0);
  let current = evaluate(windows, spec, theta);
  let lambda = 1e-3;
  for (let iteration = 0; iteration < 40; iteration += 1) {
    const jacobian = transpose(current.jacobian);
    const hessian = matMul(jacobian, current.jacobian);
    const gradient = matVec(jacobian, current.residuals);
    if (norm(gradient) < 1e-6) {
      break;
    }
    const damped = hessian.map((row) => row.slice());
    for (let index = 0; index < spec.count; index += 1) {
      const row = damped[index];
      if (!row) {
        continue;
      }
      row[index] = (row[index] ?? 0) * (1 + lambda) + 1e-8;
    }
    const step = solveLinear(damped, gradient.map((value) => -value));
    if (!step || step.some((value) => !Number.isFinite(value))) {
      lambda = Math.min(lambda * 10, 1e12);
      if (lambda >= 1e12) {
        break;
      }
      continue;
    }
    const nextTheta = theta.map((value, index) => value + (step[index] ?? 0));
    const u = nextTheta[spec.uIndex] ?? 0;
    nextTheta[spec.uIndex] = Math.min(U_MAX, Math.max(U_MIN, u));
    const trial = evaluate(windows, spec, nextTheta);
    if (trial.cost <= current.cost) {
      theta = nextTheta;
      current = trial;
      lambda = Math.max(lambda / 3, 1e-8);
      if (norm(step) < 1e-8) {
        break;
      }
    } else {
      lambda = Math.min(lambda * 3, 1e12);
      if (lambda >= 1e12) {
        break;
      }
    }
  }
  const jacobian = transpose(current.jacobian);
  const hessian = matMul(jacobian, current.jacobian);
  const covariance = invert(hessian) ?? diagonal(spec.priorSd.map((sd) => sd * sd));
  return { theta, covariance: symmetrize(covariance), cost: current.cost };
}

function evaluate(windows: EnergyWindow[], spec: ParamSpec, theta: number[]): Evaluation {
  const rows = windows.length + spec.count;
  const residuals = new Array<number>(rows).fill(0);
  const jacobian = Array.from({ length: rows }, () => new Array<number>(spec.count).fill(0));
  windows.forEach((window, row) => {
    let intake = 0;
    const dIntake = new Array<number>(spec.count).fill(0);
    for (const group of window.groups) {
      const catIndex = spec.categoryIndex[categoryIndex(group.category)];
      const foodIndex = spec.foodParam.get(group.id);
      const categoryDelta = catIndex === undefined ? 0 : (theta[catIndex] ?? 0);
      const foodDelta = foodIndex === undefined ? 0 : (theta[foodIndex] ?? 0);
      const delta = (theta[spec.delta0Index] ?? 0) + categoryDelta + foodDelta;
      const contribution = Math.exp(delta) * group.metKcal;
      intake += contribution;
      dIntake[spec.delta0Index] = (dIntake[spec.delta0Index] ?? 0) + contribution;
      if (catIndex !== undefined) {
        dIntake[catIndex] = (dIntake[catIndex] ?? 0) + contribution;
      }
      if (foodIndex !== undefined) {
        dIntake[foodIndex] = (dIntake[foodIndex] ?? 0) + contribution;
      }
    }
    const u = theta[spec.uIndex] ?? 0;
    const expenditure = window.formulaPerDay * Math.exp(u);
    const mean = intake / window.days - expenditure;
    residuals[row] = (window.storagePerDay - mean) / window.sigma;
    for (let column = 0; column < spec.count; column += 1) {
      let dMean = (dIntake[column] ?? 0) / window.days;
      if (column === spec.uIndex) {
        dMean = -expenditure;
      }
      const rowValues = jacobian[row];
      if (rowValues) {
        rowValues[column] = -dMean / window.sigma;
      }
    }
  });
  for (let column = 0; column < spec.count; column += 1) {
    const row = windows.length + column;
    const sd = spec.priorSd[column] ?? 1;
    residuals[row] = (theta[column] ?? 0) / sd;
    const rowValues = jacobian[row];
    if (rowValues) {
      rowValues[column] = 1 / sd;
    }
  }
  const cost = residuals.reduce((sum, residual) => sum + residual * residual, 0);
  return { residuals, jacobian, cost };
}

function fitFromTheta(
  windows: EnergyWindow[],
  spec: ParamSpec,
  theta: number[],
  covariance: number[][],
  cost: number,
  mode: FitMode,
): CorrectionFit {
  const delta0 = theta[spec.delta0Index] ?? 0;
  const expenditureLog = theta[spec.uIndex] ?? 0;
  const expenditureSd = Math.sqrt(Math.max(0, variance(covariance, [spec.uIndex])));
  const categories = CATEGORIES.map((category) => {
    const index = spec.categoryIndex[categoryIndex(category)];
    const delta = index === undefined ? 0 : (theta[index] ?? 0);
    const indexes = index === undefined ? [spec.delta0Index] : [spec.delta0Index, index];
    return categoryEstimate(category, delta, delta0, variance(covariance, indexes));
  });
  const foods = spec.foodIds.map((id) => {
    const index = spec.foodParam.get(id);
    const [categoryName, key] = id.split("\t");
    const category = categoryName as Category;
    const catIndex = spec.categoryIndex[categoryIndex(category)];
    const delta = index === undefined ? 0 : (theta[index] ?? 0);
    const indexes = [spec.delta0Index];
    if (catIndex !== undefined) {
      indexes.push(catIndex);
    }
    if (index !== undefined) {
      indexes.push(index);
    }
    const estimate = logFactorEstimate(delta0 + (catIndex === undefined ? 0 : (theta[catIndex] ?? 0)) + delta, variance(covariance, indexes));
    return {
      id,
      key: key ?? id,
      category,
      delta,
      ...estimate,
    };
  });
  return {
    fitted: true,
    mode,
    windowCount: windows.length,
    delta0,
    expenditureLog,
    expenditureFactor: Math.exp(expenditureLog),
    expenditureLow: Math.exp(expenditureLog - Z90 * expenditureSd),
    expenditureHigh: Math.exp(expenditureLog + Z90 * expenditureSd),
    categories,
    foods,
    cost,
  };
}

function categoryEstimate(category: Category, delta: number, delta0: number, logVariance: number): CategoryEstimate {
  return {
    category,
    delta,
    ...logFactorEstimate(delta0 + delta, logVariance),
  };
}

function logFactorEstimate(logFactor: number, logVariance: number): FactorEstimate {
  const sd = Math.sqrt(Math.max(0, logVariance));
  const factor = Math.exp(logFactor);
  const low = Math.exp(logFactor - Z90 * sd);
  const high = Math.exp(logFactor + Z90 * sd);
  return {
    factor,
    low,
    high,
    applied: clipFactor(factor),
    excludesOne: low > 1 || high < 1,
  };
}

export function clipFactor(factor: number): number {
  return Math.min(FACTOR_CLIP_HIGH, Math.max(FACTOR_CLIP_LOW, factor));
}

function variance(covariance: number[][], indexes: number[]): number {
  let total = 0;
  for (const row of indexes) {
    for (const column of indexes) {
      total += covariance[row]?.[column] ?? 0;
    }
  }
  return total;
}

function squaredError(window: EnergyWindow, fit: CorrectionFit): number {
  const residual = (window.storagePerDay - predictStorage(window, fit)) / window.sigma;
  return residual * residual;
}

function stdev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const varianceSum = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(varianceSum / (values.length - 1));
}

function norm(values: number[]): number {
  return Math.hypot(...values);
}

function diagonal(values: number[]): number[][] {
  return values.map((value, row) => {
    const line = new Array<number>(values.length).fill(0);
    line[row] = value;
    return line;
  });
}

function symmetrize(matrix: number[][]): number[][] {
  return matrix.map((row, i) =>
    row.map((value, j) => {
      const mirrored = matrix[j]?.[i] ?? value;
      return (value + mirrored) / 2;
    }),
  );
}

function transpose(matrix: number[][]): number[][] {
  const rows = matrix.length;
  const cols = matrix[0]?.length ?? 0;
  const out = Array.from({ length: cols }, () => new Array<number>(rows).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      const row = out[j];
      if (row) {
        row[i] = matrix[i]?.[j] ?? 0;
      }
    }
  }
  return out;
}

function matMul(left: number[][], right: number[][]): number[][] {
  const rows = left.length;
  const cols = right[0]?.length ?? 0;
  const inner = right.length;
  const out = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i += 1) {
    for (let k = 0; k < inner; k += 1) {
      const value = left[i]?.[k] ?? 0;
      if (value === 0) {
        continue;
      }
      for (let j = 0; j < cols; j += 1) {
        const row = out[i];
        if (row) {
          row[j] = (row[j] ?? 0) + value * (right[k]?.[j] ?? 0);
        }
      }
    }
  }
  return out;
}

function matVec(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => row.reduce((sum, value, index) => sum + value * (vector[index] ?? 0), 0));
}

export function solveLinear(matrix: number[][], vector: number[]): number[] | undefined {
  const n = vector.length;
  const rows = matrix.map((row, index) => {
    const copy = row.slice();
    copy.push(vector[index] ?? 0);
    return copy;
  });
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(rows[col]?.[col] ?? 0);
    for (let row = col + 1; row < n; row += 1) {
      const value = Math.abs(rows[row]?.[col] ?? 0);
      if (value > best) {
        best = value;
        pivot = row;
      }
    }
    if (best < 1e-12) {
      return undefined;
    }
    if (pivot !== col) {
      const swapped = rows[col];
      rows[col] = rows[pivot] ?? [];
      rows[pivot] = swapped ?? [];
    }
    const diag = rows[col]?.[col] ?? 0;
    for (let row = col + 1; row < n; row += 1) {
      const factor = (rows[row]?.[col] ?? 0) / diag;
      if (factor === 0) {
        continue;
      }
      for (let k = col; k <= n; k += 1) {
        const line = rows[row];
        const pivotLine = rows[col];
        if (line && pivotLine) {
          line[k] = (line[k] ?? 0) - factor * (pivotLine[k] ?? 0);
        }
      }
    }
  }
  const solution = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = rows[row]?.[n] ?? 0;
    for (let col = row + 1; col < n; col += 1) {
      sum -= (rows[row]?.[col] ?? 0) * (solution[col] ?? 0);
    }
    const diag = rows[row]?.[row] ?? 0;
    if (Math.abs(diag) < 1e-12) {
      return undefined;
    }
    solution[row] = sum / diag;
  }
  return solution;
}

function invert(matrix: number[][]): number[][] | undefined {
  const n = matrix.length;
  const columns: number[][] = [];
  for (let column = 0; column < n; column += 1) {
    const basis = new Array<number>(n).fill(0);
    basis[column] = 1;
    const solution = solveLinear(
      matrix.map((row) => row.slice()),
      basis,
    );
    if (!solution) {
      return undefined;
    }
    columns.push(solution);
  }
  return Array.from({ length: n }, (_, row) => columns.map((column) => column[row] ?? 0));
}
