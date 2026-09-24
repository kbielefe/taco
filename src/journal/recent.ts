import { nameKey } from "./validate.js";
import type { FieldType, FieldValue, JournalField, JournalFieldValue, JournalKind, JournalObservation } from "./types.js";

export function recentValueKey(type: FieldType, value: FieldValue): string | undefined {
  switch (type) {
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return undefined;
      }
      return `n:${value}`;
    case "boolean":
      if (typeof value !== "boolean") {
        return undefined;
      }
      return value ? "b:1" : "b:0";
    case "event":
      if (value !== true) {
        return undefined;
      }
      return "b:1";
    case "text":
    case "enum": {
      if (typeof value !== "string") {
        return undefined;
      }
      const key = nameKey(value);
      if (!key) {
        return undefined;
      }
      return `s:${key}`;
    }
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

/** Most recent value of each later field, keyed by the first field's value. */
export function recentFieldValues(
  kind: JournalKind,
  observations: JournalObservation[],
): Record<string, JournalFieldValue[]> {
  const first = kind.fields[0];
  const rest = kind.fields.slice(1);
  if (!first || rest.length === 0) {
    return {};
  }
  const relevant = observations
    .filter((observation) => observation.kindId.equals(kind._id))
    .slice()
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  const found = new Map<string, Map<string, FieldValue>>();
  for (const observation of relevant) {
    const lead = observation.values.find((value) => value.fieldId === first.id);
    if (!lead) {
      continue;
    }
    const key = recentValueKey(first.type, lead.value);
    if (!key) {
      continue;
    }
    let bucket = found.get(key);
    if (!bucket) {
      bucket = new Map();
      found.set(key, bucket);
    }
    for (const field of rest) {
      if (bucket.has(field.id)) {
        continue;
      }
      const stored = observation.values.find((value) => value.fieldId === field.id);
      if (!stored || !valueFits(field, stored.value)) {
        continue;
      }
      bucket.set(field.id, stored.value);
    }
  }
  const recentValues: Record<string, JournalFieldValue[]> = {};
  for (const [key, bucket] of found) {
    const values: JournalFieldValue[] = [];
    for (const field of rest) {
      const value = bucket.get(field.id);
      if (value !== undefined) {
        values.push({ fieldId: field.id, value });
      }
    }
    if (values.length > 0) {
      recentValues[key] = values;
    }
  }
  return recentValues;
}

function valueFits(field: JournalField, value: FieldValue): boolean {
  switch (field.type) {
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "enum":
      return typeof value === "string" && (field.options?.includes(value) ?? false);
    case "text":
      return typeof value === "string" && nameKey(value).length > 0;
    case "boolean":
      return typeof value === "boolean";
    case "event":
      return value === true;
    default: {
      const unreachable: never = field.type;
      return unreachable;
    }
  }
}
