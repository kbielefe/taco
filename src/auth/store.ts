import { type Collection, type Db } from "mongodb";

export const OAUTH_COLLECTION = "oauth";

export type OauthKind = "session" | "google-state" | "link" | "code" | "access" | "refresh" | "request";

export interface OauthRecord {
  _id: string;
  kind: OauthKind;
  expiresAt: Date;
  email?: string;
  clientId?: string;
  redirectUri?: string;
  /** Set once an Alexa request has a final reply. */
  speech?: string;
}

export interface OauthStore {
  put(record: OauthRecord): Promise<void>;
  get(id: string): Promise<OauthRecord | null>;
  /** Insert a request row only when that id is new. */
  claimRequest(id: string, expiresAt: Date): Promise<OauthRecord | null>;
  delete(id: string): Promise<void>;
}

function fresh(record: OauthRecord | null, now: Date): OauthRecord | null {
  if (!record || record.expiresAt.getTime() <= now.getTime()) {
    return null;
  }
  return record;
}

export class MemoryOauthStore implements OauthStore {
  private readonly records = new Map<string, OauthRecord>();

  async put(record: OauthRecord): Promise<void> {
    this.records.set(record._id, record);
  }

  async get(id: string): Promise<OauthRecord | null> {
    const record = fresh(this.records.get(id) ?? null, new Date());
    if (!record) {
      this.records.delete(id);
    }
    return record;
  }

  async claimRequest(id: string, expiresAt: Date): Promise<OauthRecord | null> {
    const existing = await this.get(id);
    if (existing) {
      return existing;
    }
    const created: OauthRecord = { _id: id, kind: "request", expiresAt };
    this.records.set(id, created);
    return null;
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export class MongoOauthStore implements OauthStore {
  private readonly collection: Collection<OauthRecord>;

  constructor(db: Db) {
    this.collection = db.collection<OauthRecord>(OAUTH_COLLECTION);
  }

  async ensureIndexes(): Promise<void> {
    await this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  }

  async put(record: OauthRecord): Promise<void> {
    await this.collection.replaceOne({ _id: record._id }, record, { upsert: true });
  }

  async get(id: string): Promise<OauthRecord | null> {
    const record = await this.collection.findOne({ _id: id });
    return fresh(record, new Date());
  }

  async claimRequest(id: string, expiresAt: Date): Promise<OauthRecord | null> {
    const previous = await this.collection.findOneAndUpdate(
      { _id: id },
      { $setOnInsert: { _id: id, kind: "request", expiresAt } },
      { upsert: true, returnDocument: "before" },
    );
    return fresh(previous, new Date());
  }

  async delete(id: string): Promise<void> {
    await this.collection.deleteOne({ _id: id });
  }
}
