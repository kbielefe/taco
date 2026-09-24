import type { ReadCollection } from "./catalog.js";

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 20;

const COLLECTION_DESCRIPTIONS: Record<ReadCollection, string> = {
  food: "One document per logged meal. eatenAt (date), query (typed text), description (resolved title), macros {caloriesKcal, proteinG, fatG, carbG, fiberG} as logged amounts, items[] {name, fdcId, description, dataType, grams, servingDescription, macros}, createdAt (date). Index {eatenAt: -1}.",
  observations:
    "One document per journal entry. at (date), kindId (ObjectId of a kinds document), values[] {fieldId, value} where value is a number, string, or boolean, createdAt (date). Indexes {at: -1} and {kindId: 1, at: 1}.",
  kinds:
    "Journal schema, one document per kind. label, nameKey, fields[] {id, label, type, unit?, options?}, createdAt (date). Field types are number, enum, text, boolean, and event. observations.values[].fieldId matches fields[].id. Index {nameKey: 1} unique.",
};

export function collectionDescription(collection: ReadCollection): string {
  return COLLECTION_DESCRIPTIONS[collection];
}

export function inferFields(documents: unknown[]): Record<string, string[]> {
  const types = new Map<string, Set<string>>();
  for (const document of documents) {
    walk(document, "", types, 0);
  }
  const fields: Record<string, string[]> = {};
  for (const path of [...types.keys()].sort()) {
    fields[path] = [...(types.get(path) ?? [])].sort();
  }
  return fields;
}

function walk(value: unknown, path: string, types: Map<string, Set<string>>, depth: number): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  const type = valueType(value);
  if (path) {
    const seen = types.get(path) ?? new Set<string>();
    seen.add(type);
    types.set(path, seen);
  }
  if (Array.isArray(value)) {
    const itemPath = path ? `${path}[]` : "[]";
    for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
      walk(item, itemPath, types, depth + 1);
    }
    return;
  }
  if (type === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key, types, depth + 1);
    }
  }
}

function valueType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value instanceof Date) {
    return "date";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "object") {
    const bsonType = (value as { _bsontype?: unknown })._bsontype;
    if (typeof bsonType === "string") {
      return bsonType.toLowerCase();
    }
    return "object";
  }
  return typeof value;
}
