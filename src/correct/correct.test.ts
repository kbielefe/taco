import { describe, expect, it } from "vitest";
import type { BodyProfile } from "../energy/profile.js";
import { DAY_MS, KCAL_PER_KG, type WeightObservation } from "../energy/recommend.js";
import { classifyFood, foodKey } from "./category.js";
import { clipFactor, correctionFor, energyResiduals, fitEnergyWindows, leaveOneOut, solveLinear, type CorrectionFit } from "./fit.js";
import { flatPlanted, simulateHistory, type MenuLine } from "./simulate.js";
import {
  CATEGORIES,
  SIGMA_FLOOR_KCAL,
  type Category,
  type CorrectionItem,
  type EnergyWindow,
  type LoggedMeal,
} from "./types.js";
import { buildEnergyWindows, localDayKey, weightTrend } from "./windows.js";

const PROFILE: BodyProfile = {
  birthYear: 1980,
  sex: "male",
  heightCm: 178,
  activity: "sedentary",
};
const START = new Date(Date.UTC(2026, 0, 5));

function item(overrides: Partial<CorrectionItem> & Pick<CorrectionItem, "name">): CorrectionItem {
  return {
    dataType: "Foundation",
    grams: 100,
    servingDescription: "100 g",
    macros: { caloriesKcal: 100, proteinG: 5, fatG: 2, carbG: 10, fiberG: 1 },
    ...overrides,
  };
}

function meal(day: number, items: CorrectionItem[]): LoggedMeal {
  return { eatenAt: new Date(START.getTime() + day * DAY_MS + 12 * 60 * 60 * 1000), items };
}

function weight(day: number, kg: number, unit = "kg"): WeightObservation {
  const value = unit === "lb" ? kg * 2.2046226218 : kg;
  return {
    at: new Date(START.getTime() + day * DAY_MS + 7 * 60 * 60 * 1000),
    kindLabel: "weight",
    fields: [{ id: "weight", label: "weight", type: "number", unit }],
    values: [{ fieldId: "weight", value }],
  };
}

function logEveryDay(days: number, foods: CorrectionItem[] = [item({ name: "rice", servingDescription: "1 cup", macros: riceMacros() })]): LoggedMeal[] {
  return Array.from({ length: days }, (_, day) => meal(day, foods));
}

function riceMacros(): CorrectionItem["macros"] {
  return { caloriesKcal: 200, proteinG: 4, fatG: 0.5, carbG: 44, fiberG: 0.6 };
}

describe("classifyFood", () => {
  it("uses the first matching kind", () => {
    expect(classifyFood(item({ name: "Cola", dataType: "Branded", servingDescription: "1 can", macros: { caloriesKcal: 140, proteinG: 0, fatG: 0, carbG: 39, fiberG: 0 } }))).toBe("branded");
    expect(classifyFood(item({ name: "Banana", servingDescription: "1 medium banana", grams: 118, macros: { caloriesKcal: 105, proteinG: 1.3, fatG: 0.4, carbG: 27, fiberG: 3 } }))).toBe("discrete");
    expect(classifyFood(item({ name: "Olive oil", servingDescription: "1 tbsp", grams: 14, macros: { caloriesKcal: 119, proteinG: 0, fatG: 13.5, carbG: 0, fiberG: 0 } }))).toBe("energy");
    expect(classifyFood(item({ name: "Chicken burrito", dataType: "Survey (FNDDS)", servingDescription: "1 bowl", grams: 300, macros: { caloriesKcal: 500, proteinG: 25, fatG: 18, carbG: 55, fiberG: 6 } }))).toBe("mixed");
    expect(classifyFood(item({ name: "Coffee", dataType: "SR Legacy", servingDescription: "1 cup", grams: 240, macros: { caloriesKcal: 2, proteinG: 0.3, fatG: 0, carbG: 0, fiberG: 0 } }))).toBe("beverage");
    expect(classifyFood(item({ name: "Rice, white, cooked", servingDescription: "1 cup", grams: 158, macros: riceMacros() }))).toBe("other");
  });

  it("does not treat a branded oil spoon as a whole package", () => {
    expect(
      classifyFood(item({ name: "Olive oil", dataType: "Branded", servingDescription: "1 tbsp", grams: 14, macros: { caloriesKcal: 120, proteinG: 0, fatG: 14, carbG: 0, fiberG: 0 } })),
    ).toBe("energy");
  });

  it("normalizes the habit key", () => {
    expect(foodKey("  Chicken   Burrito ")).toBe("chicken burrito");
  });
});

describe("buildEnergyWindows", () => {
  it("reads a local day in the given time zone", () => {
    expect(localDayKey(new Date("2026-01-05T03:30:00.000Z"), "UTC")).toBe("2026-01-05");
    expect(localDayKey(new Date("2026-01-05T03:30:00.000Z"), "America/Chicago")).toBe("2026-01-04");
  });

  it("turns a week between weigh-ins into storage in kcal per day", () => {
    const windows = buildEnergyWindows({
      profile: PROFILE,
      timeZone: "UTC",
      meals: logEveryDay(7),
      observations: [weight(0, 80), weight(7, 79)],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.days).toBe(7);
    expect(windows[0]?.storagePerDay).toBeCloseTo(-KCAL_PER_KG / 7, 6);
    expect(windows[0]?.sigma).toBe(SIGMA_FLOOR_KCAL);
    expect(windows[0]?.formulaPerDay).toBeGreaterThan(2000);
    expect(windows[0]?.formulaPerDay).toBeLessThan(2030);
    expect(windows[0]?.missingDays).toBe(0);
  });

  it("accepts pounds and averages two weigh-ins on the same morning", () => {
    const windows = buildEnergyWindows({
      profile: PROFILE,
      timeZone: "UTC",
      meals: logEveryDay(7),
      observations: [weight(0, 80, "lb"), weight(0, 80, "lb"), weight(7, 80, "lb")],
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]?.storagePerDay).toBeCloseTo(0, 4);
  });

  it("keeps a quiet week from getting infinite weight", () => {
    const points = Array.from({ length: 8 }, (_, day) => ({ day, kg: 80 }));
    expect(weightTrend(points)?.se).toBe(0);
    const windows = buildEnergyWindows({
      profile: PROFILE,
      timeZone: "UTC",
      meals: logEveryDay(7),
      observations: points.map((point) => weight(point.day, point.kg)),
    });
    expect(windows[0]?.sigma).toBe(SIGMA_FLOOR_KCAL);
  });

  it("drops a gap shorter than 5 days, longer than 14, or missing more than one food day", () => {
    const meals = logEveryDay(28);
    expect(buildEnergyWindows({ profile: PROFILE, timeZone: "UTC", meals, observations: [weight(0, 80), weight(4, 80)] })).toHaveLength(0);
    expect(buildEnergyWindows({ profile: PROFILE, timeZone: "UTC", meals, observations: [weight(0, 80), weight(20, 80)] })).toHaveLength(0);
    const sparse = meals.filter((entry) => {
      const day = Math.round((entry.eatenAt.getTime() - START.getTime()) / DAY_MS);
      return day % 7 !== 1 && day % 7 !== 4;
    });
    expect(buildEnergyWindows({ profile: PROFILE, timeZone: "UTC", meals: sparse, observations: [weight(0, 80), weight(7, 80)] })).toHaveLength(0);
  });

  it("keeps a week that is missing a single day and skips to the next usable span", () => {
    const meals = logEveryDay(27).filter((entry) => Math.round((entry.eatenAt.getTime() - START.getTime()) / DAY_MS) !== 3);
    const observations = [0, 20, 27].map((day) => weight(day, 80));
    const windows = buildEnergyWindows({ profile: PROFILE, timeZone: "UTC", meals, observations });
    expect(windows.map((window) => [window.startDay, window.endDay])).toEqual([["2026-01-25", "2026-02-01"]]);
  });

  it("packs daily weigh-ins into non-overlapping weeks", () => {
    const observations = Array.from({ length: 15 }, (_, day) => weight(day, 80));
    const windows = buildEnergyWindows({ profile: PROFILE, timeZone: "UTC", meals: logEveryDay(14), observations });
    expect(windows.map((window) => window.days)).toEqual([7, 7]);
    expect(windows[1]?.startDay).toBe(windows[0]?.endDay);
  });
});

describe("fitEnergyWindows", () => {
  it("solves a linear system", () => {
    const solution = solveLinear(
      [
        [0, 2],
        [4, 0],
      ],
      [4, 8],
    );
    expect(solution?.[0]).toBeCloseTo(2);
    expect(solution?.[1]).toBeCloseTo(2);
  });

  it("matches the energy residual derivatives", () => {
    const windows = contrastingWindows();
    const width = parameterCount(windows);
    const baseTheta = new Array<number>(width).fill(0.04);
    baseTheta[width - 1] = 0.02;
    const base = energyResiduals(windows, baseTheta, "hierarchy");
    const step = 1e-6;
    for (let column = 0; column < width; column += 1) {
      const bumped = baseTheta.slice();
      bumped[column] = (bumped[column] ?? 0) + step;
      const next = energyResiduals(windows, bumped, "hierarchy");
      for (let row = 0; row < base.residuals.length; row += 1) {
        const numeric = ((next.residuals[row] ?? 0) - (base.residuals[row] ?? 0)) / step;
        const analytic = base.jacobian[row]?.[column] ?? 0;
        const scale = Math.max(1, Math.abs(analytic));
        expect(Math.abs(numeric - analytic) / scale).toBeLessThan(1e-4);
      }
    }
  });

  it("gives a repeated food its own factor only when its share is not the category", () => {
    const locked = Array.from({ length: 6 }, (_, index) =>
      handWindow(index, [
        { category: "energy", name: "peanut butter", met: 800 },
        { category: "other", name: "rice", met: index % 2 === 0 ? 400 : 900 },
      ]),
    );
    expect(fitEnergyWindows(locked).foods).toHaveLength(0);

    const split = Array.from({ length: 4 }, (_, index) =>
      handWindow(index, [
        { category: "energy", name: "peanut butter", met: index % 2 === 0 ? 900 : 200 },
        { category: "energy", name: "almond butter", met: index % 2 === 0 ? 200 : 900 },
        { category: "other", name: "rice", met: 400 },
      ]),
    );
    const foods = fitEnergyWindows(split).foods.map((food) => food.key).sort();
    expect(foods).toEqual(["almond butter", "peanut butter"]);
    expect(fitEnergyWindows(split.slice(0, 3)).foods).toHaveLength(0);
  });

  it("clips an applied factor and ignores a food whose interval still includes 1", () => {
    const fit = fakeFit();
    const burrito = item({
      name: "Chicken burrito",
      dataType: "Survey (FNDDS)",
      servingDescription: "1 bowl",
      grams: 300,
      macros: { caloriesKcal: 500, proteinG: 25, fatG: 18, carbG: 55, fiberG: 6 },
    });
    expect(correctionFor(fit, burrito).foodSpecific).toBe(false);
    expect(correctionFor(fit, burrito).factor).toBe(1.5);
    const wings = item({
      name: "Hot wings",
      dataType: "Survey (FNDDS)",
      servingDescription: "1 order",
      grams: 200,
      macros: { caloriesKcal: 600, proteinG: 30, fatG: 35, carbG: 20, fiberG: 0 },
    });
    expect(correctionFor(fit, wings)).toMatchObject({ foodSpecific: true, factor: 1.5, raw: 2 });
    const water = item({ name: "Water", dataType: "SR Legacy", servingDescription: "1 cup", macros: { caloriesKcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0 } });
    expect(correctionFor(fit, water).factor).toBe(1);
    expect(clipFactor(3)).toBe(1.5);
  });
});

describe("simulated energy balance", () => {
  it("recovers category factors from 12 contrasting weeks", () => {
    const samples = Array.from({ length: 12 }, (_, seed) =>
      fitSim({ seed: seed + 1, noise: 0.2, planted: recoveryPlanted(), menu: recoveryMenu, hidden: 25 }),
    );
    expect(Math.abs(mean(samples, "energy") - 1.25)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(mean(samples, "mixed") - 4 / 3)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(mean(samples, "discrete") - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(mean(samples, "branded") - 1)).toBeLessThanOrEqual(0.05);

    const quiet = fitSim({ seed: 1, noise: 0, planted: recoveryPlanted(), menu: recoveryMenu, hidden: 25 });
    expect(Math.abs(factor(quiet, "discrete") - 1)).toBeLessThanOrEqual(0.05);
    expect(Math.abs(factor(quiet, "energy") - 1.25)).toBeLessThanOrEqual(0.15);
    expect(Math.abs(factor(quiet, "mixed") - 4 / 3)).toBeLessThanOrEqual(0.15);
  });

  it("puts a higher burn on expenditure when every food is logged honestly", () => {
    const fit = fitSim({
      seed: 1,
      noise: 0,
      planted: flatPlanted(1),
      menu: () => constantMenu(),
      expenditureFactor: 1.15,
    });
    for (const category of CATEGORIES) {
      expect(Math.abs(Math.exp(categoryDelta(fit, category)) - 1)).toBeLessThanOrEqual(0.05);
    }
    expect(fit.expenditureFactor).toBeGreaterThan(1.05);
    expect(fit.expenditureFactor).toBeLessThan(1.2);
    const largestCategoryMove = Math.max(...CATEGORIES.map((category) => Math.abs(factor(fit, category) - 1)));
    expect(fit.expenditureFactor - 1).toBeGreaterThan(largestCategoryMove);
    expect(fit.expenditureFactor).toBeLessThan(1.6);
  });

  it("does not learn under-logging from weeks that were only partly written down", () => {
    const dropped = fitSim({
      seed: 1,
      noise: 0,
      planted: flatPlanted(1),
      menu: () => constantMenu(),
      skipLog: (day) => day % 5 < 2,
    });
    expect(dropped.windowCount).toBe(0);
    expect(dropped.expenditureFactor).toBe(1);
    for (const category of CATEGORIES) {
      expect(factor(dropped, category)).toBe(1);
    }

    const unfiltered = fitSim({
      seed: 1,
      noise: 0,
      planted: flatPlanted(1),
      menu: () => constantMenu(),
      skipLog: (day) => day % 5 < 2,
      maxMissingDays: 14,
    });
    const categoryShift = Math.max(...CATEGORIES.map((category) => Math.abs(factor(unfiltered, category) - 1)));
    const expenditureShift = Math.abs(unfiltered.expenditureFactor - 1);
    expect(categoryShift > 0.1 || expenditureShift > 0.1).toBe(true);
  });

  it("covers planted factors and does not collapse the interval", () => {
    let covered = 0;
    let checks = 0;
    let narrowest = Infinity;
    for (let seed = 1; seed <= 40; seed += 1) {
      const fit = fitSim({ seed, noise: 0.25, planted: recoveryPlanted(), menu: recoveryMenu });
      for (const category of ["energy", "mixed"] as const) {
        const estimate = fit.categories.find((entry) => entry.category === category);
        const planted = recoveryPlanted()[category];
        checks += 1;
        if (estimate && estimate.low <= planted && planted <= estimate.high) {
          covered += 1;
        }
        if (estimate) {
          narrowest = Math.min(narrowest, estimate.high - estimate.low);
        }
      }
    }
    expect(covered / checks).toBeGreaterThanOrEqual(0.8);
    expect(narrowest).toBeGreaterThan(0.05);
  });

  it("needs several contrasting weeks before a category interval leaves 1", () => {
    let detected: number | undefined;
    for (let weeks = 4; weeks <= 36; weeks += 2) {
      const fit = fitSim({ seed: 1, noise: 0, weeks, planted: recoveryPlanted(), menu: (week) => biasMenu(week, 700) });
      const mixed = fit.categories.find((entry) => entry.category === "mixed");
      if (mixed?.excludesOne && mixed.factor > 1) {
        detected = weeks;
        break;
      }
    }
    expect(detected).toBeGreaterThanOrEqual(24);
    expect(detected).toBeLessThanOrEqual(48);
  });

  it("lets category corrections beat one global factor when the menu alternates", () => {
    const history = simulateHistory({
      seed: 1,
      weeks: 12,
      profile: PROFILE,
      start: START,
      planted: recoveryPlanted(),
      expenditureFactor: 1,
      menu: recoveryMenu,
      weightNoiseKg: 0,
      hiddenKcal: () => 25,
    });
    const windows = buildEnergyWindows({ profile: history.profile, meals: history.meals, observations: history.observations, timeZone: "UTC" });
    const score = leaveOneOut(windows);
    expect(score.hierarchyError).toBeLessThan(score.globalError);
    expect(score.globalError).toBeLessThan(score.nullError);
  });

  it("stays inside the literature range for a strong planted bias", () => {
    for (const plantedMixed of [0.7, 1.4]) {
      const fit = fitSim({
        seed: 1,
        noise: 0,
        planted: { ...recoveryPlanted(), mixed: plantedMixed },
        menu: recoveryMenu,
      });
      expect(Math.abs(factor(fit, "mixed") - plantedMixed)).toBeLessThanOrEqual(0.15);
    }
  });
});

function recoveryPlanted(): Record<Category, number> {
  return { ...flatPlanted(1), energy: 1.25, mixed: 4 / 3 };
}

function recoveryMenu(week: number): MenuLine[] {
  return rotatingMenu(week, 1600);
}

function biasMenu(week: number, biasedMet: number): MenuLine[] {
  return rotatingMenu(week, biasedMet);
}

/** The same background every week, plus peanut butter or a burrito on alternating weeks.
 *  A food that replaces rice is confounded with rice; an added food is not.
 */
function rotatingMenu(week: number, biasedMet: number): MenuLine[] {
  const background: MenuLine[] = [
    { name: "banana", category: "discrete", metKcal: 400 },
    { name: "yogurt", category: "branded", metKcal: 350 },
    { name: "rice", category: "other", metKcal: 500 },
    { name: "coffee", category: "beverage", metKcal: 25 },
  ];
  const phase = week % 3;
  if (phase === 1) {
    background.push({ name: "peanut butter", category: "energy", metKcal: biasedMet });
  } else if (phase === 2) {
    background.push({ name: "chicken burrito", category: "mixed", metKcal: biasedMet });
  }
  return background;
}

function constantMenu(): MenuLine[] {
  return [
    { name: "banana", category: "discrete", metKcal: 400 },
    { name: "peanut butter", category: "energy", metKcal: 400 },
    { name: "chicken burrito", category: "mixed", metKcal: 400 },
    { name: "yogurt", category: "branded", metKcal: 400 },
    { name: "rice", category: "other", metKcal: 400 },
    { name: "coffee", category: "beverage", metKcal: 25 },
  ];
}

function fitSim(input: {
  seed: number;
  noise: number;
  planted: Record<Category, number>;
  menu: (week: number) => MenuLine[];
  expenditureFactor?: number;
  skipLog?: (day: number) => boolean;
  maxMissingDays?: number;
  weeks?: number;
  hidden?: number;
}): CorrectionFit {
  const history = simulateHistory({
    seed: input.seed,
    weeks: input.weeks ?? 12,
    profile: PROFILE,
    start: START,
    planted: input.planted,
    expenditureFactor: input.expenditureFactor ?? 1,
    menu: input.menu,
    weightNoiseKg: input.noise,
    skipLog: input.skipLog,
    hiddenKcal: () => input.hidden ?? 0,
  });
  const windows = buildEnergyWindows({
    profile: history.profile,
    meals: history.meals,
    observations: history.observations,
    timeZone: "UTC",
    maxMissingDays: input.maxMissingDays,
  });
  return fitEnergyWindows(windows);
}

function factor(fit: CorrectionFit, category: Category): number {
  return fit.categories.find((entry) => entry.category === category)?.factor ?? 1;
}

function categoryDelta(fit: CorrectionFit, category: Category): number {
  return fit.categories.find((entry) => entry.category === category)?.delta ?? 0;
}

function mean(fits: CorrectionFit[], category: Category): number {
  return fits.reduce((sum, fit) => sum + factor(fit, category), 0) / fits.length;
}

function handWindow(index: number, foods: { category: Category; name: string; met: number }[]): EnergyWindow {
  const start = new Date(Date.UTC(2026, 0, 5 + index * 7));
  const end = new Date(start.getTime() + 7 * DAY_MS);
  return {
    startDay: start.toISOString().slice(0, 10),
    endDay: end.toISOString().slice(0, 10),
    days: 7,
    storagePerDay: 0,
    sigma: SIGMA_FLOOR_KCAL,
    formulaPerDay: 2000,
    loggedDays: 7,
    missingDays: 0,
    groups: foods.map((food) => ({
      id: `${food.category}\t${foodKey(food.name)}`,
      category: food.category,
      foodKey: foodKey(food.name),
      metKcal: food.met * 7,
    })),
  };
}

function contrastingWindows(): EnergyWindow[] {
  return [
    handWindow(0, [
      { category: "discrete", name: "banana", met: 500 },
      { category: "other", name: "rice", met: 1500 },
    ]),
    handWindow(1, [
      { category: "energy", name: "peanut butter", met: 800 },
      { category: "mixed", name: "chicken burrito", met: 1200 },
    ]),
  ];
}

function parameterCount(windows: EnergyWindow[]): number {
  const probe = energyResiduals(windows, new Array(8).fill(0), "hierarchy");
  return probe.jacobian[0]?.length ?? 0;
}

function fakeFit(): CorrectionFit {
  return {
    fitted: true,
    mode: "hierarchy",
    windowCount: 8,
    delta0: 0,
    expenditureLog: 0,
    expenditureFactor: 1,
    expenditureLow: 0.9,
    expenditureHigh: 1.1,
    cost: 0,
    categories: CATEGORIES.map((category) => ({
      category,
      delta: category === "mixed" ? Math.log(1.8) : 0,
      factor: category === "mixed" ? 1.8 : 1,
      low: category === "mixed" ? 1.4 : 0.8,
      high: category === "mixed" ? 2.2 : 1.2,
      applied: category === "mixed" ? 1.5 : 1,
      excludesOne: category === "mixed",
    })),
    foods: [
      {
        id: "mixed\tchicken burrito",
        key: "chicken burrito",
        category: "mixed",
        delta: 0,
        factor: 1.8,
        low: 0.9,
        high: 2.4,
        applied: 1.5,
        excludesOne: false,
      },
      {
        id: "mixed\thot wings",
        key: "hot wings",
        category: "mixed",
        delta: Math.log(2),
        factor: 2,
        low: 1.6,
        high: 2.5,
        applied: 1.5,
        excludesOne: true,
      },
    ],
  };
}

