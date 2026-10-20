import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { MemoryFoodStore } from "./store.js";
import type { FoodLogEntry, FoodLogMacros } from "./types.js";

const macros: FoodLogMacros = { caloriesKcal: 100, proteinG: 1, fatG: 1, carbG: 10, fiberG: 1 };

function entry(overrides: Partial<FoodLogEntry> = {}): Omit<FoodLogEntry, "_id"> {
  return {
    eatenAt: new Date("2026-09-20T12:00:00Z"),
    query: "banana",
    description: "banana (1 medium)",
    macros,
    items: [],
    createdAt: new Date("2026-09-20T12:00:00Z"),
    ...overrides,
  };
}

describe("MemoryFoodStore", () => {
  it("lists entries in an eatenAt range, newest first", async () => {
    const store = new MemoryFoodStore();
    const morning = await store.insert(entry({ eatenAt: new Date("2026-09-20T08:00:00Z"), query: "oatmeal" }));
    await store.insert(entry({ eatenAt: new Date("2026-09-19T12:00:00Z"), query: "yesterday" }));
    const lunch = await store.insert(entry({ eatenAt: new Date("2026-09-20T12:00:00Z"), query: "banana" }));
    await store.insert(entry({ eatenAt: new Date("2026-09-21T00:00:00Z"), query: "tomorrow" }));

    const listed = await store.listByEatenAt(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
    expect(listed.map((item) => item.query)).toEqual(["banana", "oatmeal"]);
    expect(listed[0]?._id).toEqual(lunch._id);
    expect(listed[1]?._id).toEqual(morning._id);
  });

  it("deletes by id and returns false when missing", async () => {
    const store = new MemoryFoodStore();
    const stored = await store.insert(entry());
    expect(await store.deleteById(stored._id.toString())).toBe(true);
    expect(store.entries).toHaveLength(0);
    expect(await store.deleteById(stored._id.toString())).toBe(false);
    expect(await store.deleteById("not-an-id")).toBe(false);
    expect(await store.deleteById(new ObjectId().toString())).toBe(false);
  });

  it("stores a serving count and clears it at one", async () => {
    const store = new MemoryFoodStore();
    const stored = await store.insert(entry());
    const doubled = await store.setServings(stored._id.toString(), 2);
    expect(doubled?.servings).toBe(2);
    expect(store.entries[0]?.servings).toBe(2);
    const single = await store.setServings(stored._id.toString(), 1);
    expect(single?.servings).toBeUndefined();
    expect(await store.setServings(new ObjectId().toString(), 2)).toBeNull();
  });
});
