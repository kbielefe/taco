import { correctionFor, correctedMacros, type CorrectionFit, type ItemCorrection } from "../correct/fit.js";
import type { Category } from "../correct/types.js";
import type { JournalKindView, JournalObservationView } from "../journal/journal.js";
import type { JournalField } from "../journal/types.js";
import { sumMacros } from "../log/nutrients.js";
import type { FoodLogEntry, FoodLogItem, FoodLogMacros } from "../log/types.js";

const CATEGORY_LABEL: Record<Category, string> = {
  branded: "labeled package",
  discrete: "counted food",
  energy: "rich food",
  mixed: "mixed dish",
  beverage: "drink",
  other: "other",
};

export interface ItemCorrectionJson {
  factor: number;
  label: string;
}

export interface MealItemJson extends FoodLogItem {
  correction?: ItemCorrectionJson;
}

export interface MealJson {
  id: string;
  eatenAt: string;
  createdAt: string;
  query: string;
  description: string;
  macros: FoodLogMacros;
  adjusted?: FoodLogMacros;
  items: MealItemJson[];
}

export function serializeMeal(entry: FoodLogEntry, fit?: CorrectionFit | null): MealJson {
  const meal: MealJson = {
    id: entry._id.toHexString(),
    eatenAt: entry.eatenAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    query: entry.query,
    description: entry.description,
    macros: entry.macros,
    items: entry.items,
  };
  if (!fit) {
    return meal;
  }
  meal.items = entry.items.map((item) => {
    const correction = correctionFor(fit, item);
    return { ...item, correction: { factor: correction.factor, label: correctionLabel(correction) } };
  });
  meal.adjusted = sumMacros(entry.items.map((item) => correctedMacros(item, fit)));
  return meal;
}

function correctionLabel(correction: ItemCorrection): string {
  return correction.foodSpecific ? "its own factor" : CATEGORY_LABEL[correction.category];
}

export interface JournalFieldJson {
  id: string;
  label: string;
  type: JournalField["type"];
  unit?: string;
  options?: string[];
}

export interface JournalKindJson {
  id: string;
  label: string;
  fields: JournalFieldJson[];
  lastUsedAt: string | null;
  suggestions: Record<string, string[]>;
}

export interface JournalObservationJson {
  id: string;
  at: string;
  createdAt: string;
  kind: { id: string; label: string; fields: JournalFieldJson[] };
  values: JournalObservationView["observation"]["values"];
}

export function serializeField(field: JournalField): JournalFieldJson {
  const json: JournalFieldJson = { id: field.id, label: field.label, type: field.type };
  if (field.unit !== undefined) {
    json.unit = field.unit;
  }
  if (field.options) {
    json.options = field.options;
  }
  return json;
}

export function serializeKind(view: JournalKindView): JournalKindJson {
  return {
    id: view.kind._id.toHexString(),
    label: view.kind.label,
    fields: view.kind.fields.map(serializeField),
    lastUsedAt: view.lastUsedAt ? view.lastUsedAt.toISOString() : null,
    suggestions: view.suggestions,
  };
}

export function serializeObservation(view: JournalObservationView): JournalObservationJson {
  return {
    id: view.observation._id.toHexString(),
    at: view.observation.at.toISOString(),
    createdAt: view.observation.createdAt.toISOString(),
    kind: {
      id: view.kind._id.toHexString(),
      label: view.kind.label,
      fields: view.kind.fields.map(serializeField),
    },
    values: view.observation.values,
  };
}

export function parseIsoDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return date;
}
