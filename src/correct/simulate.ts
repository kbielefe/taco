import type { BodyProfile } from "../energy/profile.js";
import { DAY_MS, KCAL_PER_KG, type WeightObservation } from "../energy/recommend.js";
import { classifyFood, metabolizableKcal } from "./category.js";
import { formulaPerDay } from "./formula.js";
import { CATEGORIES, type Category, type CorrectionItem, type LoggedMeal } from "./types.js";

const TEF_PROTEIN = 0.25;
const TEF_CARB = 0.075;
const TEF_FAT = 0.02;
const WATER_TAU_DAYS = 2;

export interface MenuLine {
  name: string;
  category: Category;
  /** Metabolizable kcal the log will record for this item, before the planted factor. */
  metKcal: number;
}

export interface SimulateOptions {
  seed?: number;
  weeks: number;
  profile?: BodyProfile;
  startKg?: number;
  /** UTC midnight of the first morning weigh-in. */
  start?: Date;
  planted: Record<Category, number>;
  /** True expenditure is the body-size formula times this. */
  expenditureFactor: number;
  menu: (week: number) => MenuLine[];
  hiddenKcal?: (day: number, rng: () => number) => number;
  skipLog?: (day: number) => boolean;
  weightNoiseKg?: number;
  /** Share of today's imbalance that enters the fast water compartment. */
  waterShare?: number;
}

export interface SimulatedHistory {
  profile: BodyProfile;
  meals: LoggedMeal[];
  observations: WeightObservation[];
  planted: Record<Category, number>;
}

const DEFAULT_PROFILE: BodyProfile = {
  birthYear: 1980,
  sex: "male",
  heightCm: 178,
  activity: "sedentary",
};

export function simulateHistory(options: SimulateOptions): SimulatedHistory {
  const profile = options.profile ?? DEFAULT_PROFILE;
  const planted = { ...options.planted };
  const start = options.start ?? new Date(Date.UTC(2026, 0, 5));
  const rng = mulberry32(options.seed ?? 1);
  const noiseKg = options.weightNoiseKg ?? 0;
  const waterShare = options.waterShare ?? 0.2;
  const days = options.weeks * 7;
  let fatKg = options.startKg ?? 80;
  let waterKg = 0;
  const meals: LoggedMeal[] = [];
  const observations: WeightObservation[] = [];

  for (let day = 0; day <= days; day += 1) {
    const scaleKg = fatKg + waterKg;
    const noise = noiseKg === 0 ? 0 : gaussian(rng) * noiseKg;
    observations.push(weighIn(atHour(start, day, 7), scaleKg + noise));
    if (day === days) {
      break;
    }
    const lines = options.menu(Math.floor(day / 7));
    const items: CorrectionItem[] = [];
    let trueMet = options.hiddenKcal?.(day, rng) ?? 0;
    for (const line of lines) {
      if (line.metKcal <= 0) {
        continue;
      }
      const item = itemFor(line);
      const logged = metabolizableKcal(item.macros);
      trueMet += logged * planted[line.category];
      items.push(item);
    }
    if (!options.skipLog?.(day)) {
      meals.push({ eatenAt: atHour(start, day, 12), items });
    }
    const year = atHour(start, day, 7).getUTCFullYear();
    const expenditure = formulaPerDay(scaleKg, profile, year) * options.expenditureFactor;
    const balance = trueMet - expenditure;
    // Fat keeps the whole imbalance. Water is a transient on top, so a settled week
    // still slopes at KCAL_PER_KG and a menu change adds a short glycogen swing.
    fatKg += balance / KCAL_PER_KG;
    waterKg = waterKg * Math.exp(-1 / WATER_TAU_DAYS) + (waterShare * balance) / KCAL_PER_KG;
  }

  return { profile, meals, observations, planted };
}

export function flatPlanted(factor = 1): Record<Category, number> {
  return Object.fromEntries(CATEGORIES.map((category) => [category, factor])) as Record<Category, number>;
}

function itemFor(line: MenuLine): CorrectionItem {
  const built = buildItem(line);
  const classified = classifyFood(built);
  if (classified !== line.category) {
    throw new Error(`Sim item ${line.name} classified as ${classified}, wanted ${line.category}.`);
  }
  return built;
}

function buildItem(line: MenuLine): CorrectionItem {
  switch (line.category) {
    case "branded":
      return makeItem(line, "Branded", "1 cup", 120, 0.25, 0.25);
    case "discrete":
      return makeItem(line, "Foundation", "1 medium banana", 89, 0.05, 0.05);
    case "energy":
      return makeItem(line, "SR Legacy", "2 tbsp", 588, 0.8, 0.15);
    case "mixed":
      return makeItem(line, "Survey (FNDDS)", "1 bowl", 190, 0.35, 0.25);
    case "beverage":
      return makeItem({ ...line, name: drinkName(line.name) }, "SR Legacy", "1 cup", 2, 0, 0);
    case "other":
      return makeItem(line, "Foundation", "1 cup", 130, 0.02, 0.08);
  }
}

function makeItem(
  line: MenuLine,
  dataType: string,
  serving: string,
  kcalPer100: number,
  fatFrac: number,
  proteinFrac: number,
): CorrectionItem {
  const carbFrac = Math.max(0, 1 - fatFrac - proteinFrac);
  const tef = TEF_PROTEIN * proteinFrac + TEF_CARB * carbFrac + TEF_FAT * fatFrac;
  const kcal = line.metKcal / (1 - tef);
  return {
    name: line.name,
    dataType,
    grams: (kcal / kcalPer100) * 100,
    servingDescription: serving,
    macros: {
      caloriesKcal: kcal,
      proteinG: (kcal * proteinFrac) / 4,
      fatG: (kcal * fatFrac) / 9,
      carbG: (kcal * carbFrac) / 4,
      fiberG: 0,
    },
  };
}

function drinkName(name: string): string {
  return /\b(?:coffee|tea|water|soda|juice|milk|beer|wine|drink|beverage)\b/i.test(name) ? name : `${name} coffee`;
}

function weighIn(at: Date, kg: number): WeightObservation {
  return {
    at,
    kindLabel: "weight",
    fields: [{ id: "weight", label: "weight", type: "number", unit: "kg" }],
    values: [{ fieldId: "weight", value: kg }],
  };
}

function atHour(start: Date, day: number, hour: number): Date {
  return new Date(start.getTime() + day * DAY_MS + hour * 60 * 60 * 1000);
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u1 = Math.max(rng(), 1e-12);
  const u2 = rng();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
