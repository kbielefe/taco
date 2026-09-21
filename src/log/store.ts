import { ObjectId, type Collection, type Db } from "mongodb";
import { FOOD_COLLECTION, type FoodLogEntry, type FoodStore } from "./types.js";

export class MemoryFoodStore implements FoodStore {
  readonly entries: FoodLogEntry[] = [];

  async insert(entry: Omit<FoodLogEntry, "_id">): Promise<FoodLogEntry> {
    const stored: FoodLogEntry = { ...entry, _id: new ObjectId() };
    this.entries.push(stored);
    return stored;
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
    const result = await this.collection.insertOne(entry as FoodLogEntry);
    return { ...entry, _id: result.insertedId };
  }
}
