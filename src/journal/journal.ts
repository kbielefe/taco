import { MongoClient } from "mongodb";
import { JournalConfigError, JournalConflictError, JournalNotFoundError, JournalValidationError } from "./errors.js";
import { MongoJournalStore } from "./store.js";
import {
  HEALTH_DB,
  TEXT_SUGGESTION_LIMIT,
  type JournalField,
  type JournalKind,
  type JournalObservation,
  type JournalStore,
} from "./types.js";
import { defineFields, nameKey, normalizeKindLabel, validateValues, withAppendedOptions, type OptionUpdate } from "./validate.js";

export interface NewKindInput {
  label: unknown;
  fields: unknown;
}

export interface LogJournalInput {
  kindId?: string;
  kind?: NewKindInput;
  at?: Date;
  values: unknown;
}

export interface AppendKindInput {
  addFields?: unknown;
  addOptions?: unknown;
}

export interface JournalKindView {
  kind: JournalKind;
  lastUsedAt: Date | null;
  suggestions: Record<string, string[]>;
}

export interface JournalObservationView {
  observation: JournalObservation;
  kind: JournalKind;
}

export interface CreateJournalOptions {
  store?: JournalStore;
  mongoUri?: string;
}

export class Journal {
  constructor(
    private readonly store: JournalStore,
    private readonly mongo?: MongoClient,
    private readonly ownsMongo = false,
  ) {}

  async close(): Promise<void> {
    if (this.ownsMongo) {
      await this.mongo?.close();
    }
  }

  async log(input: LogJournalInput): Promise<JournalObservationView> {
    const at = input.at ?? new Date();
    if (input.kindId) {
      const kind = await this.store.findKind(input.kindId);
      if (!kind) {
        throw new JournalNotFoundError("That kind wasn't found.");
      }
      const values = validateValues(kind.fields, input.values);
      const observation = await this.store.insertObservation({
        at,
        kindId: kind._id,
        values,
        createdAt: new Date(),
      });
      return { observation, kind };
    }
    if (!input.kind) {
      throw new JournalValidationError("Choose what you're recording.");
    }
    const label = normalizeKindLabel(input.kind.label);
    const fields = defineFields(input.kind.fields);
    const values = validateValues(fields, input.values);
    const now = new Date();
    let kind: JournalKind;
    try {
      kind = await this.store.insertKind({ label, nameKey: nameKey(label), fields, createdAt: now });
    } catch (error) {
      if (error instanceof JournalConflictError) {
        throw new JournalConflictError("That name is already used.");
      }
      throw error;
    }
    try {
      const observation = await this.store.insertObservation({
        at,
        kindId: kind._id,
        values,
        createdAt: new Date(),
      });
      return { observation, kind };
    } catch (error) {
      await this.store.deleteKind(kind._id.toHexString());
      throw error;
    }
  }

  async list(from: Date, to: Date): Promise<JournalObservationView[]> {
    const [observations, kinds] = await Promise.all([this.store.listObservations(from, to), this.store.listKinds()]);
    const byId = new Map(kinds.map((kind) => [kind._id.toHexString(), kind]));
    const views: JournalObservationView[] = [];
    for (const observation of observations) {
      const kind = byId.get(observation.kindId.toHexString());
      if (kind) {
        views.push({ observation, kind });
      }
    }
    return views;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.deleteObservation(id);
  }

  async get(id: string): Promise<JournalObservationView | null> {
    const observation = await this.store.findObservation(id);
    if (!observation) {
      return null;
    }
    const kind = await this.store.findKind(observation.kindId.toHexString());
    if (!kind) {
      return null;
    }
    return { observation, kind };
  }

  async kinds(): Promise<JournalKindView[]> {
    const [kinds, observations] = await Promise.all([this.store.listKinds(), this.store.listAllObservations()]);
    return kinds
      .map((kind) => ({
        kind,
        lastUsedAt: lastUsedAt(kind, observations),
        suggestions: textSuggestions(kind, observations),
      }))
      .sort((a, b) => {
        const used = (b.lastUsedAt?.getTime() ?? -1) - (a.lastUsedAt?.getTime() ?? -1);
        if (used !== 0) {
          return used;
        }
        return a.kind.label.localeCompare(b.kind.label, "en-US");
      });
  }

  async append(id: string, input: AppendKindInput): Promise<JournalKind> {
    const kind = await this.store.findKind(id);
    if (!kind) {
      throw new JournalNotFoundError("That kind wasn't found.");
    }
    const addFields = input.addFields === undefined ? [] : input.addFields;
    const addOptions = parseOptionUpdates(input.addOptions);
    if (!Array.isArray(addFields)) {
      throw new JournalValidationError("Add at least one field.");
    }
    if (addFields.length === 0 && addOptions.length === 0) {
      throw new JournalValidationError("Nothing to add.");
    }
    let fields: JournalField[] = kind.fields;
    if (addFields.length > 0) {
      fields = [...fields, ...defineFields(addFields, fields)];
    }
    if (addOptions.length > 0) {
      fields = withAppendedOptions(fields, addOptions);
    }
    const saved = await this.store.saveFields(kind._id.toHexString(), fields);
    if (!saved) {
      throw new JournalNotFoundError("That kind wasn't found.");
    }
    return saved;
  }
}

export async function createJournal(options: CreateJournalOptions = {}): Promise<Journal> {
  if (options.store) {
    return new Journal(options.store);
  }
  const uri = options.mongoUri ?? process.env.MONGODB_URI;
  if (!uri) {
    throw new JournalConfigError("MONGODB_URI is not set");
  }
  const mongo = new MongoClient(uri);
  await mongo.connect();
  try {
    const store = await MongoJournalStore.connect(mongo.db(HEALTH_DB));
    return new Journal(store, mongo, true);
  } catch (error) {
    await mongo.close();
    throw error;
  }
}

function parseOptionUpdates(raw: unknown): OptionUpdate[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new JournalValidationError("Nothing to add.");
  }
  return raw.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new JournalNotFoundError("That field isn't on this kind.");
    }
    const record = item as Record<string, unknown>;
    if (typeof record.fieldId !== "string" || !record.fieldId) {
      throw new JournalNotFoundError("That field isn't on this kind.");
    }
    return { fieldId: record.fieldId, options: record.options };
  });
}

function lastUsedAt(kind: JournalKind, observations: JournalObservation[]): Date | null {
  let latest: Date | null = null;
  for (const observation of observations) {
    if (!observation.kindId.equals(kind._id)) {
      continue;
    }
    if (!latest || observation.at > latest) {
      latest = observation.at;
    }
  }
  return latest;
}

function textSuggestions(kind: JournalKind, observations: JournalObservation[]): Record<string, string[]> {
  const textFields = kind.fields.filter((field) => field.type === "text").map((field) => field.id);
  const suggestions: Record<string, string[]> = {};
  const seen = new Map<string, Set<string>>();
  for (const fieldId of textFields) {
    suggestions[fieldId] = [];
    seen.set(fieldId, new Set());
  }
  if (textFields.length === 0) {
    return suggestions;
  }
  const relevant = observations
    .filter((observation) => observation.kindId.equals(kind._id))
    .slice()
    .sort((a, b) => b.at.getTime() - a.at.getTime() || b.createdAt.getTime() - a.createdAt.getTime());
  for (const observation of relevant) {
    for (const value of observation.values) {
      const bucket = suggestions[value.fieldId];
      const used = seen.get(value.fieldId);
      if (!bucket || !used || typeof value.value !== "string" || used.has(value.value)) {
        continue;
      }
      if (bucket.length >= TEXT_SUGGESTION_LIMIT) {
        continue;
      }
      used.add(value.value);
      bucket.push(value.value);
    }
  }
  return suggestions;
}
