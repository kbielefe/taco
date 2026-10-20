import type { Macros } from "./api.js";

export const emptyMacros: Macros = {
  caloriesKcal: 0,
  proteinG: 0,
  fatG: 0,
  carbG: 0,
  fiberG: 0,
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function scaleMacros(macros: Macros, factor: number): Macros {
  return {
    caloriesKcal: Math.round(macros.caloriesKcal * factor),
    proteinG: round1(macros.proteinG * factor),
    fatG: round1(macros.fatG * factor),
    carbG: round1(macros.carbG * factor),
    fiberG: round1(macros.fiberG * factor),
  };
}

export function sumMacros(items: Macros[]): Macros {
  const acc = items.reduce(
    (sum, item) => ({
      caloriesKcal: sum.caloriesKcal + item.caloriesKcal,
      proteinG: sum.proteinG + item.proteinG,
      fatG: sum.fatG + item.fatG,
      carbG: sum.carbG + item.carbG,
      fiberG: sum.fiberG + item.fiberG,
    }),
    emptyMacros,
  );
  return {
    caloriesKcal: Math.round(acc.caloriesKcal),
    proteinG: round1(acc.proteinG),
    fatG: round1(acc.fatG),
    carbG: round1(acc.carbG),
    fiberG: round1(acc.fiberG),
  };
}

export function formatKcal(value: number): string {
  return Math.round(value).toLocaleString();
}

export function formatGrams(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatMacroLine(macros: Macros): string {
  return `${formatKcal(macros.caloriesKcal)} kcal · protein ${formatGrams(macros.proteinG)} · fat ${formatGrams(macros.fatG)} · carbs ${formatGrams(macros.carbG)} · fiber ${formatGrams(macros.fiberG)}`;
}
