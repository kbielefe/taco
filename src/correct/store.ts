import { MongoClient, type Collection, type Db } from "mongodb";
import { HEALTH_DB } from "../log/types.js";
import { withToolSpan } from "../mlflow/tracing.js";
import type { CorrectionFit } from "./fit.js";

export const CORRECTIONS_COLLECTION = "corrections";
const CURRENT_ID = "current";

export interface StoredCorrection {
  updatedAt: Date;
  timeZone: string;
  fit: CorrectionFit;
}

export interface CorrectionStore {
  read(): Promise<StoredCorrection | null>;
  save(document: StoredCorrection): Promise<void>;
}

interface CorrectionRecord extends StoredCorrection {
  _id: typeof CURRENT_ID;
}

export class MemoryCorrectionStore implements CorrectionStore {
  private document: StoredCorrection | null = null;

  async read(): Promise<StoredCorrection | null> {
    return this.document;
  }

  async save(document: StoredCorrection): Promise<void> {
    this.document = document;
  }
}

export class MongoCorrectionStore implements CorrectionStore {
  constructor(private readonly collection: Collection<CorrectionRecord>) {}

  static async connect(db: Db, collectionName = CORRECTIONS_COLLECTION): Promise<MongoCorrectionStore> {
    return new MongoCorrectionStore(db.collection<CorrectionRecord>(collectionName));
  }

  async read(): Promise<StoredCorrection | null> {
    return withToolSpan(
      "mongo corrections.read",
      { collection: this.collection.collectionName, id: CURRENT_ID },
      async () => {
        const found = await this.collection.findOne({ _id: CURRENT_ID });
        if (!found) {
          return null;
        }
        return { updatedAt: found.updatedAt, timeZone: found.timeZone, fit: found.fit };
      },
      (found) => ({ found: found !== null }),
    );
  }

  async save(document: StoredCorrection): Promise<void> {
    return withToolSpan(
      "mongo corrections.save",
      { collection: this.collection.collectionName, id: CURRENT_ID, timeZone: document.timeZone },
      async () => {
        await this.collection.updateOne(
          { _id: CURRENT_ID },
          { $set: { updatedAt: document.updatedAt, timeZone: document.timeZone, fit: document.fit } },
          { upsert: true },
        );
      },
      () => ({ stored: true }),
    );
  }
}

export async function openCorrectionStore(mongoUri: string): Promise<{ store: CorrectionStore; close: () => Promise<void> }> {
  const mongo = new MongoClient(mongoUri);
  await mongo.connect();
  try {
    const store = await MongoCorrectionStore.connect(mongo.db(HEALTH_DB));
    return { store, close: () => mongo.close() };
  } catch (error) {
    await mongo.close();
    throw error;
  }
}
