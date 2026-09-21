import { ACTIVITY_FACTORS, type ProfileRead, type Sex } from "./profile.js";

export const DAY_MS = 24 * 60 * 60 * 1000;
export const HISTORY_DAYS = 7;
export const WEIGHT_LOOKBACK_DAYS = 365;

// Usual estimate of the energy in one pound of body weight. Not exact for every person.
export const KCAL_PER_POUND = 3500;
export const POUNDS_PER_WEEK = 2;
export const DAILY_DEFICIT_KCAL = (POUNDS_PER_WEEK * KCAL_PER_POUND) / HISTORY_DAYS;
export const LB_PER_KG = 2.2046226218;
export const KCAL_PER_KG = KCAL_PER_POUND * LB_PER_KG;

// CDC healthy range is 18.5 through 24.9, so 25 is the first overweight point.
export const HEALTHY_BMI_MIN = 18.5;
export const OVERWEIGHT_BMI = 25;

// Common unsupervised floor. Eating less than this needs a clinician.
export const SAFE_MINIMUM_KCAL: Record<Sex, number> = {
  male: 1500,
  female: 1200,
};

// A shorter gap is mostly day-to-day noise, not a week of change.
export const ADAPTIVE_MIN_SPAN_DAYS = 3;
export const ADAPTIVE_CLAMP_LOW = 0.6;
export const ADAPTIVE_CLAMP_HIGH = 1.6;

const MIN_WEIGHT_KG = 20;
const MAX_WEIGHT_KG = 400;

const MASS_TO_KG: Record<string, number> = {
  lb: 1 / LB_PER_KG,
  lbs: 1 / LB_PER_KG,
  pound: 1 / LB_PER_KG,
  pounds: 1 / LB_PER_KG,
  kg: 1,
  kgs: 1,
  kilogram: 1,
  kilograms: 1,
};

export interface IntakeSample {
  eatenAt: Date;
  kcal: number;
}

export interface WeightObservation {
  at: Date;
  kindLabel: string;
  fields: { id: string; label: string; type: string; unit?: string }[];
  values: { fieldId: string; value: unknown }[];
}

export interface DayRecommendation {
  kcal: number | null;
  message: string;
  goal: "lose" | "maintain" | null;
  basis: "week" | "partial" | "body" | null;
  limitedByMinimum: boolean;
  minimumKcal: number | null;
  bmi: number | null;
}

export function energyWindow(today: Date): { from: Date; until: Date; historyFrom: Date } {
  return {
    from: new Date(today.getTime() - HISTORY_DAYS * DAY_MS),
    until: new Date(today.getTime() + DAY_MS),
    historyFrom: new Date(today.getTime() - WEIGHT_LOOKBACK_DAYS * DAY_MS),
  };
}

export function recommendDay(input: {
  profile: ProfileRead;
  today: Date;
  intakes: IntakeSample[];
  observations: WeightObservation[];
}): DayRecommendation {
  if (!input.profile.ok) {
    return unavailable(input.profile.message);
  }
  const { from, until, historyFrom } = energyWindow(input.today);
  const samples = weighIns(input.observations)
    .filter((sample) => sample.at >= historyFrom && sample.at < until)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  const inWindow = samples.filter((sample) => sample.at >= from);
  const older = samples.filter((sample) => sample.at < from);
  const chosen = inWindow.length > 0 ? inWindow : older.slice(-1);
  if (chosen.length === 0) {
    return unavailable("Log a weight to see a recommended calorie count.");
  }

  const profile = input.profile.profile;
  const weightKg = average(dailyMeans(chosen, from).map((point) => point.kg));
  const age = input.today.getUTCFullYear() - profile.birthYear;
  const formulaTdee = mifflinStJeor(weightKg, profile.heightCm, age, profile.sex) * ACTIVITY_FACTORS[profile.activity];
  const slope = slopeKgPerDay(dailyMeans(inWindow, from));
  const dayTotals = intakeByDay(input.intakes, from, input.today);
  const loggedDays = dayTotals.filter((kcal) => kcal > 0).length;
  const totalKcal = dayTotals.reduce((sum, kcal) => sum + kcal, 0);

  let tdee = formulaTdee;
  let basis: "week" | "partial" | "body" = "body";
  if (slope !== undefined && loggedDays > 0 && formulaTdee > 0) {
    const avgIntake = totalKcal / loggedDays;
    const adaptiveRaw = avgIntake - slope * KCAL_PER_KG;
    const adaptive = clamp(adaptiveRaw, formulaTdee * ADAPTIVE_CLAMP_LOW, formulaTdee * ADAPTIVE_CLAMP_HIGH);
    const fraction = Math.min(loggedDays, HISTORY_DAYS) / HISTORY_DAYS;
    tdee = fraction * adaptive + (1 - fraction) * formulaTdee;
    basis = fraction >= 1 ? "week" : "partial";
  }

  const heightM = profile.heightCm / 100;
  const bmi = weightKg / (heightM * heightM);
  const losing = bmi >= OVERWEIGHT_BMI;
  const minimum = SAFE_MINIMUM_KCAL[profile.sex];
  const goalKcal = losing ? tdee - DAILY_DEFICIT_KCAL : tdee;
  const limitedByMinimum = goalKcal < minimum;
  const kcal = Math.max(roundTo10(goalKcal), minimum);

  return {
    kcal,
    message: recommendationMessage({
      losing,
      under: bmi < HEALTHY_BMI_MIN,
      basis,
      limitedByMinimum,
      minimum,
    }),
    goal: losing ? "lose" : "maintain",
    basis,
    limitedByMinimum,
    minimumKcal: minimum,
    bmi: Math.round(bmi * 10) / 10,
  };
}

function unavailable(message: string): DayRecommendation {
  return {
    kcal: null,
    message,
    goal: null,
    basis: null,
    limitedByMinimum: false,
    minimumKcal: null,
    bmi: null,
  };
}

interface WeighIn {
  at: Date;
  kg: number;
}

function weighIns(observations: WeightObservation[]): WeighIn[] {
  const samples: WeighIn[] = [];
  for (const observation of observations) {
    const kg = observationWeightKg(observation);
    if (kg !== undefined) {
      samples.push({ at: observation.at, kg });
    }
  }
  return samples;
}

export function observationWeightKg(observation: WeightObservation): number | undefined {
  const kindIsWeight = /\bweight\b/i.test(observation.kindLabel);
  const candidates = observation.fields.filter((field) => {
    if (field.type !== "number" || !massFactor(field.unit)) {
      return false;
    }
    const fieldIsWeight = /\bweight\b/i.test(field.label) || field.id === "weight";
    return kindIsWeight || fieldIsWeight;
  });
  const field = candidates.find((item) => /\bweight\b/i.test(item.label) || item.id === "weight") ?? candidates[0];
  if (!field) {
    return undefined;
  }
  const factor = massFactor(field.unit);
  const value = observation.values.find((item) => item.fieldId === field.id)?.value;
  if (factor === undefined || typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const kg = value * factor;
  if (kg < MIN_WEIGHT_KG || kg > MAX_WEIGHT_KG) {
    return undefined;
  }
  return kg;
}

function massFactor(unit: string | undefined): number | undefined {
  if (!unit) {
    return undefined;
  }
  const key = unit.trim().toLowerCase().replace(/\.$/, "");
  return MASS_TO_KG[key];
}

function dailyMeans(samples: WeighIn[], from: Date): { day: number; kg: number }[] {
  const buckets = new Map<number, { total: number; count: number }>();
  for (const sample of samples) {
    const day = Math.floor((sample.at.getTime() - from.getTime()) / DAY_MS);
    const bucket = buckets.get(day) ?? { total: 0, count: 0 };
    bucket.total += sample.kg;
    bucket.count += 1;
    buckets.set(day, bucket);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, bucket]) => ({ day, kg: bucket.total / bucket.count }));
}

function slopeKgPerDay(points: { day: number; kg: number }[]): number | undefined {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last || points.length < 2 || last.day - first.day < ADAPTIVE_MIN_SPAN_DAYS) {
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
  return numerator / denominator;
}

function intakeByDay(intakes: IntakeSample[], from: Date, today: Date): number[] {
  const totals = Array.from({ length: HISTORY_DAYS }, () => 0);
  for (const intake of intakes) {
    if (intake.eatenAt < from || intake.eatenAt >= today || !Number.isFinite(intake.kcal) || intake.kcal <= 0) {
      continue;
    }
    const index = Math.floor((intake.eatenAt.getTime() - from.getTime()) / DAY_MS);
    const current = totals[index];
    if (current !== undefined) {
      totals[index] = current + intake.kcal;
    }
  }
  return totals;
}

function mifflinStJeor(weightKg: number, heightCm: number, age: number, sex: Sex): number {
  const sexOffset = sex === "male" ? 5 : -161;
  return 10 * weightKg + 6.25 * heightCm - 5 * age + sexOffset;
}

function recommendationMessage(input: {
  losing: boolean;
  under: boolean;
  basis: "week" | "partial" | "body";
  limitedByMinimum: boolean;
  minimum: number;
}): string {
  const basis =
    input.basis === "week"
      ? "from the last 7 days"
      : input.basis === "partial"
        ? "partly from the last 7 days"
        : "from your body size";
  const aim = input.losing ? "Aiming to lose 2 lb a week" : "Holding your weight";
  const floor = input.limitedByMinimum ? `, held at ${input.minimum.toLocaleString("en-US")} kcal, a safe minimum` : "";
  const bmi = input.losing ? "" : input.under ? " BMI is below the healthy range." : " BMI is in the healthy range.";
  const refine = input.basis === "body" ? " A full week of food and weight will refine this." : "";
  return `${aim}, ${basis}${floor}.${bmi}${refine}`;
}

function average(values: number[]): number {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function roundTo10(value: number): number {
  return Math.round(value / 10) * 10;
}
