import type { JournalKindView, JournalObservationView } from "../journal/journal.js";
import type { JournalField } from "../journal/types.js";
import type { FoodLogEntry, FoodLogMacros } from "../log/types.js";

export interface MealJson {
  id: string;
  eatenAt: string;
  createdAt: string;
  query: string;
  description: string;
  macros: FoodLogMacros;
  items: FoodLogEntry["items"];
}

export function serializeMeal(entry: FoodLogEntry): MealJson {
  return {
    id: entry._id.toHexString(),
    eatenAt: entry.eatenAt.toISOString(),
    createdAt: entry.createdAt.toISOString(),
    query: entry.query,
    description: entry.description,
    macros: entry.macros,
    items: entry.items,
  };
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
