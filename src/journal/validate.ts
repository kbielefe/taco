import { JournalNotFoundError, JournalValidationError } from "./errors.js";
import { FIELD_TYPES, type FieldType, type JournalField, type JournalFieldValue } from "./types.js";

const KIND_LABEL_MAX = 80;
const FIELD_LABEL_MAX = 40;
const UNIT_MAX = 20;
const OPTION_MAX = 40;
const TEXT_MAX = 80;

export interface OptionUpdate {
  fieldId: string;
  options: unknown;
}

export function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function nameKey(label: string): string {
  return normalizeText(label).toLocaleLowerCase("en-US");
}

export function fieldSlug(label: string): string {
  const base = nameKey(label)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base.length > 0 ? base : "field";
}

export function normalizeKindLabel(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new JournalValidationError("Name what you're recording.");
  }
  const label = normalizeText(raw);
  if (!label) {
    throw new JournalValidationError("Name what you're recording.");
  }
  if (label.length > KIND_LABEL_MAX) {
    throw new JournalValidationError("That name is too long.");
  }
  return label;
}

export function defineFields(inputs: unknown, existing: JournalField[] = []): JournalField[] {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new JournalValidationError("Add at least one field.");
  }
  const taken = new Set(existing.map((field) => field.id));
  const labels = new Set(existing.map((field) => nameKey(field.label)));
  return inputs.map((input) => defineField(input, taken, labels));
}

export function withAppendedOptions(fields: JournalField[], updates: OptionUpdate[]): JournalField[] {
  const next = fields.map(cloneField);
  for (const update of updates) {
    const field = next.find((item) => item.id === update.fieldId);
    if (!field) {
      throw new JournalNotFoundError("That field isn't on this kind.");
    }
    if (field.type !== "enum" || !field.options) {
      throw new JournalValidationError("That field isn't a choice.");
    }
    const added = normalizeOptions(update.options, 1);
    const seen = new Set(field.options.map((option) => option.toLocaleLowerCase("en-US")));
    for (const option of added) {
      const key = option.toLocaleLowerCase("en-US");
      if (seen.has(key)) {
        throw new JournalValidationError("Those choices are the same.");
      }
      seen.add(key);
      field.options.push(option);
    }
  }
  return next;
}

export function validateValues(fields: JournalField[], raw: unknown): JournalFieldValue[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new JournalValidationError("Enter at least one thing.");
  }
  const byId = new Map(fields.map((field) => [field.id, field]));
  const seen = new Set<string>();
  const values: JournalFieldValue[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const token = record && typeof record.fieldId === "string" ? record.fieldId : "";
    const field = byId.get(token) ?? fields.find((candidate) => nameKey(candidate.label) === nameKey(token));
    if (!field) {
      throw new JournalValidationError("That field isn't on this kind.");
    }
    if (seen.has(field.id)) {
      throw new JournalValidationError("That field is set twice.");
    }
    seen.add(field.id);
    values.push({ fieldId: field.id, value: coerceValue(field, record?.value) });
  }
  return values;
}

function defineField(input: unknown, taken: Set<string>, labels: Set<string>): JournalField {
  const record = asRecord(input);
  if (!record || typeof record.label !== "string") {
    throw new JournalValidationError("Name that field.");
  }
  const label = normalizeText(record.label);
  if (!label) {
    throw new JournalValidationError("Name that field.");
  }
  if (label.length > FIELD_LABEL_MAX) {
    throw new JournalValidationError("That field name is too long.");
  }
  const key = nameKey(label);
  if (labels.has(key)) {
    throw new JournalValidationError("Those fields have the same name.");
  }
  labels.add(key);
  if (!isFieldType(record.type)) {
    throw new JournalValidationError("Choose number, choice, text, yes/no, or event.");
  }
  const field: JournalField = { id: uniqueId(fieldSlug(label), taken), label, type: record.type };
  if (record.type === "number") {
    field.unit = normalizeUnit(record.unit);
  }
  if (record.type === "enum") {
    field.options = normalizeOptions(record.options, 2);
  }
  return field;
}

function normalizeUnit(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new JournalValidationError("Enter a unit, such as lb or bpm.");
  }
  const unit = normalizeText(raw);
  if (!unit) {
    throw new JournalValidationError("Enter a unit, such as lb or bpm.");
  }
  if (unit.length > UNIT_MAX) {
    throw new JournalValidationError("That unit is too long.");
  }
  return unit;
}

function normalizeOptions(raw: unknown, minimum: number): string[] {
  if (!Array.isArray(raw)) {
    throw new JournalValidationError(minimum > 1 ? "Add at least two choices." : "Name that choice.");
  }
  const options: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") {
      throw new JournalValidationError(minimum > 1 ? "Add at least two choices." : "Name that choice.");
    }
    const option = normalizeText(item);
    if (!option) {
      continue;
    }
    if (option.length > OPTION_MAX) {
      throw new JournalValidationError("That choice is too long.");
    }
    const key = option.toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new JournalValidationError("Those choices are the same.");
    }
    seen.add(key);
    options.push(option);
  }
  if (options.length < minimum) {
    throw new JournalValidationError(minimum > 1 ? "Add at least two choices." : "Name that choice.");
  }
  return options;
}

function coerceValue(field: JournalField, raw: unknown): JournalFieldValue["value"] {
  switch (field.type) {
    case "number": {
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new JournalValidationError("Enter a number.");
      }
      return raw;
    }
    case "enum": {
      if (typeof raw !== "string" || !field.options?.includes(raw)) {
        throw new JournalValidationError("Pick one of the choices.");
      }
      return raw;
    }
    case "text": {
      if (typeof raw !== "string") {
        throw new JournalValidationError("Enter some text.");
      }
      const text = normalizeText(raw);
      if (!text) {
        throw new JournalValidationError("Enter some text.");
      }
      if (text.length > TEXT_MAX) {
        throw new JournalValidationError("That text is too long.");
      }
      return text;
    }
    case "boolean": {
      if (typeof raw !== "boolean") {
        throw new JournalValidationError("Choose yes or no.");
      }
      return raw;
    }
    case "event": {
      if (raw !== true) {
        throw new JournalValidationError("An event can only be logged as happened.");
      }
      return true;
    }
    default: {
      const unreachable: never = field.type;
      return unreachable;
    }
  }
}

function uniqueId(base: string, taken: Set<string>): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  const id = `${base}-${suffix}`;
  taken.add(id);
  return id;
}

function cloneField(field: JournalField): JournalField {
  return { ...field, ...(field.options ? { options: [...field.options] } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}
