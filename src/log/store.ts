import { ObjectId, type Collection, type Db } from "mongodb";
import { withToolSpan } from "../mlflow/tracing.js";
import { FOOD_COLLECTION, type FoodLogEntry, type FoodStore } from "./types.js";

const OBJECT_ID = /^[a-fA-F0-9]{24}$/;

function byEatenAtDesc(a: FoodLogEntry, b: FoodLogEntry): number {
  const eaten = b.eatenAt.getTime() - a.eatenAt.getTime();
  if (eaten !== 0) {
    return eaten;
  }
  return b.createdAt.getTime() - a.createdAt.getTime();
}

export class MemoryFoodStore implements FoodStore {
  readonly entries: FoodLogEntry[] = [];

  async insert(entry: Omit<FoodLogEntry, "_id">): Promise<FoodLogEntry> {
    const stored: FoodLogEntry = { ...entry, _id: new ObjectId() };
    this.entries.push(stored);
    return stored;
  }

  async listByEatenAt(from: Date, to: Date): Promise<FoodLogEntry[]> {
    return this.entries
      .filter((entry) => entry.eatenAt >= from && entry.eatenAt < to)
      .slice()
      .sort(byEatenAtDesc);
  }

  async deleteById(id: string): Promise<boolean> {
    const index = this.entries.findIndex((entry) => entry._id.toString() === id);
    if (index === -1) {
      return false;
    }
    this.entries.splice(index, 1);
    return true;
  }
}

export class MongoFoodStore implements FoodStore {
  constructor(private readonly collection: Collection<FoodLogEntry>) {}

  static async connect(db: Db, collectionName = FOOD_COLLECTION): Promise<MongoFoodStore> {
    const collection = db.collection<FoodLogEntry>(collectionName);
    await collection.createIndex({ eatenAt: -1 });
    return new MongoFoodStore(collection);
  }

  async insert(entry: Omit<FoodLogEntry, "_id">): Promise<FoodLogEntry> {
    return withToolSpan(
      "mongo food.insert",
      {
        collection: this.collection.collectionName,
        query: entry.query,
        eatenAt: entry.eatenAt,
        description: entry.description,
        macros: entry.macros,
        items: entry.items.map((item) => item.name),
      },
      async () => {
        const result = await this.collection.insertOne(entry as FoodLogEntry);
        return { ...entry, _id: result.insertedId };
      },
      (stored) => ({ id: stored._id.toHexString() }),
    );
  }

  async listByEatenAt(from: Date, to: Date): Promise<FoodLogEntry[]> {
    return withToolSpan(
      "mongo food.find",
      { collection: this.collection.collectionName, from, to },
      () => this.collection.find({ eatenAt: { $gte: from, $lt: to } }).sort({ eatenAt: -1, createdAt: -1 }).toArray(),
      (rows) => ({ count: rows.length }),
    );
  }

  async deleteById(id: string): Promise<boolean> {
    return withToolSpan(
      "mongo food.delete",
      { collection: this.collection.collectionName, id },
      async () => {
        if (!OBJECT_ID.test(id)) {
          return false;
        }
        const result = await this.collection.deleteOne({ _id: new ObjectId(id) });
        return result.deletedCount === 1;
      },
      (deleted) => ({ deleted }),
    );
  }
}
