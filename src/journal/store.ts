import { MongoServerError, ObjectId, type Collection, type Db } from "mongodb";
import { withToolSpan } from "../mlflow/tracing.js";
import { JournalConflictError } from "./errors.js";
import {
  KINDS_COLLECTION,
  OBSERVATIONS_COLLECTION,
  type JournalField,
  type JournalKind,
  type JournalObservation,
  type JournalStore,
} from "./types.js";

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

function byAtDesc(a: { at: Date; createdAt: Date }, b: { at: Date; createdAt: Date }): number {
  const at = b.at.getTime() - a.at.getTime();
  if (at !== 0) {
    return at;
  }
  return b.createdAt.getTime() - a.createdAt.getTime();
}

function inRange(entry: JournalObservation, from: Date, to: Date): boolean {
  return entry.at >= from && entry.at < to;
}

export class MemoryJournalStore implements JournalStore {
  readonly kinds: JournalKind[] = [];
  readonly observations: JournalObservation[] = [];

  async insertKind(kind: Omit<JournalKind, "_id">): Promise<JournalKind> {
    if (this.kinds.some((item) => item.nameKey === kind.nameKey)) {
      throw new JournalConflictError("That name is already used.");
    }
    const stored: JournalKind = { ...kind, fields: kind.fields.map(cloneField), _id: new ObjectId() };
    this.kinds.push(stored);
    return stored;
  }

  async saveFields(id: string, fields: JournalField[]): Promise<JournalKind | null> {
    const kind = this.kinds.find((item) => item._id.toHexString() === id);
    if (!kind) {
      return null;
    }
    kind.fields = fields.map(cloneField);
    return kind;
  }

  async findKind(id: string): Promise<JournalKind | null> {
    return this.kinds.find((item) => item._id.toHexString() === id) ?? null;
  }

  async listKinds(): Promise<JournalKind[]> {
    return this.kinds.slice();
  }

  async deleteKind(id: string): Promise<boolean> {
    const index = this.kinds.findIndex((item) => item._id.toHexString() === id);
    if (index === -1) {
      return false;
    }
    this.kinds.splice(index, 1);
    return true;
  }

  async insertObservation(entry: Omit<JournalObservation, "_id">): Promise<JournalObservation> {
    const stored: JournalObservation = {
      ...entry,
      values: entry.values.map((value) => ({ ...value })),
      _id: new ObjectId(),
    };
    this.observations.push(stored);
    return stored;
  }

  async findObservation(id: string): Promise<JournalObservation | null> {
    return this.observations.find((entry) => entry._id.toHexString() === id) ?? null;
  }

  async listObservations(from: Date, to: Date): Promise<JournalObservation[]> {
    return this.observations.filter((entry) => inRange(entry, from, to)).slice().sort(byAtDesc);
  }

  async listAllObservations(): Promise<JournalObservation[]> {
    return this.observations.slice().sort(byAtDesc);
  }

  async deleteObservation(id: string): Promise<boolean> {
    const index = this.observations.findIndex((entry) => entry._id.toHexString() === id);
    if (index === -1) {
      return false;
    }
    this.observations.splice(index, 1);
    return true;
  }
}

export class MongoJournalStore implements JournalStore {
  constructor(
    private readonly kinds: Collection<JournalKind>,
    private readonly observations: Collection<JournalObservation>,
  ) {}

  static async connect(db: Db): Promise<MongoJournalStore> {
    const kinds = db.collection<JournalKind>(KINDS_COLLECTION);
    const observations = db.collection<JournalObservation>(OBSERVATIONS_COLLECTION);
    await kinds.createIndex({ nameKey: 1 }, { unique: true });
    await observations.createIndex({ at: -1 });
    await observations.createIndex({ kindId: 1, at: 1 });
    return new MongoJournalStore(kinds, observations);
  }

  async insertKind(kind: Omit<JournalKind, "_id">): Promise<JournalKind> {
    return withToolSpan(
      "mongo kinds.insert",
      { collection: this.kinds.collectionName, nameKey: kind.nameKey },
      async () => {
        try {
          const result = await this.kinds.insertOne(kind as JournalKind);
          return { ...kind, _id: result.insertedId };
        } catch (error) {
          if (error instanceof MongoServerError && error.code === 11000) {
            throw new JournalConflictError("That name is already used.");
          }
          throw error;
        }
      },
      (stored) => ({ id: stored._id.toHexString() }),
    );
  }

  async saveFields(id: string, fields: JournalField[]): Promise<JournalKind | null> {
    return withToolSpan(
      "mongo kinds.update",
      { collection: this.kinds.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return null;
        }
        return this.kinds.findOneAndUpdate({ _id: new ObjectId(id) }, { $set: { fields } }, { returnDocument: "after" });
      },
      (kind) => ({ found: kind !== null }),
    );
  }

  async findKind(id: string): Promise<JournalKind | null> {
    return withToolSpan(
      "mongo kinds.find",
      { collection: this.kinds.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return null;
        }
        return this.kinds.findOne({ _id: new ObjectId(id) });
      },
      (kind) => ({ found: kind !== null }),
    );
  }

  async listKinds(): Promise<JournalKind[]> {
    return withToolSpan(
      "mongo kinds.list",
      { collection: this.kinds.collectionName },
      () => this.kinds.find({}).toArray(),
      (kinds) => ({ count: kinds.length }),
    );
  }

  async deleteKind(id: string): Promise<boolean> {
    return withToolSpan(
      "mongo kinds.delete",
      { collection: this.kinds.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return false;
        }
        const result = await this.kinds.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount === 1;
      },
      (deleted) => ({ deleted }),
    );
  }

  async insertObservation(entry: Omit<JournalObservation, "_id">): Promise<JournalObservation> {
    return withToolSpan(
      "mongo observations.insert",
      { collection: this.observations.collectionName, kindId: entry.kindId, at: entry.at },
      async () => {
        const result = await this.observations.insertOne(entry as JournalObservation);
        return { ...entry, _id: result.insertedId };
      },
      (stored) => ({ id: stored._id.toHexString() }),
    );
  }

  async findObservation(id: string): Promise<JournalObservation | null> {
    return withToolSpan(
      "mongo observations.find",
      { collection: this.observations.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return null;
        }
        return this.observations.findOne({ _id: new ObjectId(id) });
      },
      (found) => ({ found: found !== null }),
    );
  }

  async listObservations(from: Date, to: Date): Promise<JournalObservation[]> {
    return withToolSpan(
      "mongo observations.list",
      { collection: this.observations.collectionName, from, to },
      () => this.observations.find({ at: { $gte: from, $lt: to } }).sort({ at: -1, createdAt: -1 }).toArray(),
      (rows) => ({ count: rows.length }),
    );
  }

  async listAllObservations(): Promise<JournalObservation[]> {
    return withToolSpan(
      "mongo observations.list",
      { collection: this.observations.collectionName },
      () => this.observations.find({}).sort({ at: -1, createdAt: -1 }).toArray(),
      (rows) => ({ count: rows.length }),
    );
  }

  async deleteObservation(id: string): Promise<boolean> {
    return withToolSpan(
      "mongo observations.delete",
      { collection: this.observations.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return false;
        }
        const result = await this.observations.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount === 1;
      },
      (deleted) => ({ deleted }),
    );
  }
}

function cloneField(field: JournalField): JournalField {
  return { ...field, ...(field.options ? { options: [...field.options] } : {}) };
}
