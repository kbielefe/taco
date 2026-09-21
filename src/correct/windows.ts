import type { BodyProfile } from "../energy/profile.js";
import { DAY_MS, KCAL_PER_KG, observationWeightKg, type WeightObservation } from "../energy/recommend.js";
import { classifyFood, foodKey, groupId, metabolizableKcal } from "./category.js";
import { formulaPerDay } from "./formula.js";
import {
  MAX_MISSING_DAYS,
  MAX_SPAN_DAYS,
  MIN_SPAN_DAYS,
  SIGMA_FLOOR_KCAL,
  TARGET_SPAN_DAYS,
  type EnergyGroup,
  type EnergyWindow,
  type LoggedMeal,
} from "./types.js";

export interface BuildWindowsOptions {
  profile: BodyProfile;
  meals: LoggedMeal[];
  observations: WeightObservation[];
  timeZone: string;
  maxMissingDays?: number;
}

export function localDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error("Could not read the local day.");
  }
  return `${year}-${month}-${day}`;
}

export function dayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Bad day ${key}`);
  }
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function buildEnergyWindows(options: BuildWindowsOptions): EnergyWindow[] {
  const maxMissingDays = options.maxMissingDays ?? MAX_MISSING_DAYS;
  const weights = dailyMeanKg(options.observations, options.timeZone);
  const meals = mealsByDay(options.meals, options.timeZone);
  const weightDays = [...weights.keys()].sort((a, b) => a - b);
  const windows: EnergyWindow[] = [];
  let cursor = 0;
  while (cursor < weightDays.length - 1) {
    const start = weightDays[cursor];
    if (start === undefined) {
      break;
    }
    const end = pickEndDay(weightDays, cursor);
    if (end === undefined) {
      cursor += 1;
      continue;
    }
    const window = makeWindow({
      start,
      end,
      weights,
      weightDays,
      meals,
      profile: options.profile,
      maxMissingDays,
    });
    if (!window) {
      cursor += 1;
      continue;
    }
    windows.push(window);
    const endIndex = weightDays.indexOf(end);
    if (endIndex <= cursor) {
      break;
    }
    cursor = endIndex;
  }
  return windows;
}

function pickEndDay(weightDays: number[], cursor: number): number | undefined {
  const start = weightDays[cursor];
  if (start === undefined) {
    return undefined;
  }
  let best: number | undefined;
  let bestDistance = Infinity;
  for (let index = cursor + 1; index < weightDays.length; index += 1) {
    const end = weightDays[index];
    if (end === undefined) {
      continue;
    }
    const span = end - start;
    if (span < MIN_SPAN_DAYS) {
      continue;
    }
    if (span > MAX_SPAN_DAYS) {
      break;
    }
    const distance = Math.abs(span - TARGET_SPAN_DAYS);
    if (best === undefined || distance < bestDistance || (distance === bestDistance && end < best)) {
      best = end;
      bestDistance = distance;
    }
  }
  return best;
}

function makeWindow(input: {
  start: number;
  end: number;
  weights: Map<number, number>;
  weightDays: number[];
  meals: Map<number, LoggedMeal[]>;
  profile: BodyProfile;
  maxMissingDays: number;
}): EnergyWindow | undefined {
  const days = input.end - input.start;
  if (days < MIN_SPAN_DAYS) {
    return undefined;
  }
  let loggedDays = 0;
  for (let day = input.start; day < input.end; day += 1) {
    if (input.meals.has(day)) {
      loggedDays += 1;
    }
  }
  const missingDays = days - loggedDays;
  if (missingDays > input.maxMissingDays) {
    return undefined;
  }
  const points = input.weightDays
    .filter((day) => day >= input.start && day <= input.end)
    .map((day) => ({ day: day - input.start, kg: input.weights.get(day) ?? 0 }));
  const trend = weightTrend(points);
  if (!trend || points.length < 2) {
    return undefined;
  }
  const absolute = points.map((point) => ({ day: point.day + input.start, kg: point.kg }));
  let formulaSum = 0;
  for (let day = input.start; day < input.end; day += 1) {
    const year = new Date(day * DAY_MS).getUTCFullYear();
    formulaSum += formulaPerDay(weightAt(absolute, day), input.profile, year);
  }
  const groups = groupsBetween(input.meals, input.start, input.end);
  return {
    startDay: dayKeyFromNumber(input.start),
    endDay: dayKeyFromNumber(input.end),
    days,
    storagePerDay: trend.slope * KCAL_PER_KG,
    // Two weigh-ins sit on a perfect line, so scatter is not a standard error.
    sigma: Math.max(SIGMA_FLOOR_KCAL, (trend.se ?? 0) * KCAL_PER_KG),
    formulaPerDay: formulaSum / days,
    loggedDays,
    missingDays,
    groups,
  };
}

function groupsBetween(meals: Map<number, LoggedMeal[]>, start: number, end: number): EnergyGroup[] {
  const groups = new Map<string, EnergyGroup>();
  for (let day = start; day < end; day += 1) {
    for (const meal of meals.get(day) ?? []) {
      for (const item of meal.items) {
        const metKcal = metabolizableKcal(item.macros);
        if (metKcal <= 0) {
          continue;
        }
        const category = classifyFood(item);
        const key = foodKey(item.name);
        const id = groupId(category, key);
        const existing = groups.get(id);
        if (existing) {
          existing.metKcal += metKcal;
        } else {
          groups.set(id, { id, category, foodKey: key, metKcal });
        }
      }
    }
  }
  return [...groups.values()];
}

function dailyMeanKg(observations: WeightObservation[], timeZone: string): Map<number, number> {
  const buckets = new Map<number, { total: number; count: number }>();
  for (const observation of observations) {
    const kg = observationWeightKg(observation);
    if (kg === undefined) {
      continue;
    }
    const day = dayNumber(localDayKey(observation.at, timeZone));
    const bucket = buckets.get(day) ?? { total: 0, count: 0 };
    bucket.total += kg;
    bucket.count += 1;
    buckets.set(day, bucket);
  }
  return new Map([...buckets.entries()].map(([day, bucket]) => [day, bucket.total / bucket.count]));
}

function mealsByDay(meals: LoggedMeal[], timeZone: string): Map<number, LoggedMeal[]> {
  const byDay = new Map<number, LoggedMeal[]>();
  for (const meal of meals) {
    const day = dayNumber(localDayKey(meal.eatenAt, timeZone));
    const list = byDay.get(day) ?? [];
    list.push(meal);
    byDay.set(day, list);
  }
  return byDay;
}

function weightAt(points: { day: number; kg: number }[], day: number): number {
  const first = points[0];
  if (!first) {
    return 0;
  }
  let previous = first;
  for (const point of points) {
    if (point.day === day) {
      return point.kg;
    }
    if (point.day > day) {
      const span = point.day - previous.day;
      const t = span === 0 ? 0 : (day - previous.day) / span;
      return previous.kg + t * (point.kg - previous.kg);
    }
    previous = point;
  }
  return previous.kg;
}

/** Ordinary least-squares slope of kg on day, the same regression as the weekly expenditure estimate. */
export function weightTrend(points: { day: number; kg: number }[]): { slope: number; se: number | undefined } | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2 || last.day === first.day) {
    return undefined;
  }
  let sumT = 0;
  let sumY = 0;
  for (const point of points) {
    sumT += point.day;
    sumY += point.kg;
  }
  const meanT = sumT / points.length;
  const meanY = sumY / points.length;
  let numerator = 0;
  let denominator = 0;
  for (const point of points) {
    const delta = point.day - meanT;
    numerator += delta * (point.kg - meanY);
    denominator += delta * delta;
  }
  if (denominator === 0) {
    return undefined;
  }
  const slope = numerator / denominator;
  if (points.length < 3) {
    return { slope, se: undefined };
  }
  let sse = 0;
  for (const point of points) {
    const residual = point.kg - (meanY + slope * (point.day - meanT));
    sse += residual * residual;
  }
  const dof = points.length - 2;
  if (dof <= 0 || sse === 0) {
    return { slope, se: 0 };
  }
  return { slope, se: Math.sqrt(sse / dof) / Math.sqrt(denominator) };
}

function dayKeyFromNumber(day: number): string {
  const date = new Date(day * DAY_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dayOfMonth = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${dayOfMonth}`;
}
