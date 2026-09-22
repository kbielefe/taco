import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../fdc/cache.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import { FoodLogger } from "../log/logger.js";
import { MemoryFoodStore } from "../log/store.js";
import type { FoodLogMacros } from "../log/types.js";
import { fitEnergyWindows } from "./fit.js";
import { createCorrectionRunner, isWeighIn, loadHistory } from "./run.js";
import { MemoryCorrectionStore } from "./store.js";

const PROFILE = { BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70" };
const MACROS: FoodLogMacros = { caloriesKcal: 100, proteinG: 1, fatG: 0.2, carbG: 23, fiberG: 2 };

function emptyHistory() {
  return { meals: [], observations: [] };
}

describe("correction runner", () => {
  it("waits until the next turn, then stores the fit", async () => {
    const store = new MemoryCorrectionStore();
    let ran = false;
    const runner = createCorrectionRunner({
      store,
      env: PROFILE,
      load: async () => {
        ran = true;
        return emptyHistory();
      },
    });
    runner.schedule({ timeZone: "UTC" });
    expect(ran).toBe(false);
    expect(runner.pending()).toBe(true);
    await runner.whenIdle();
    expect(ran).toBe(true);
    expect(runner.pending()).toBe(false);
    const saved = await store.read();
    expect(saved?.timeZone).toBe("UTC");
    expect(saved?.fit.fitted).toBe(false);
    expect(saved?.fit.categories).toHaveLength(6);
  });

  it("runs one fit at a time", async () => {
    let active = 0;
    let max = 0;
    const runner = createCorrectionRunner({
      store: new MemoryCorrectionStore(),
      env: PROFILE,
      load: async () => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return emptyHistory();
      },
    });
    runner.schedule({ timeZone: "UTC" });
    runner.schedule({ timeZone: "UTC" });
    await runner.whenIdle();
    expect(max).toBe(1);
  });

  it("keeps the stored fit when the profile is missing or the load fails", async () => {
    const store = new MemoryCorrectionStore();
    const previous = {
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      timeZone: "UTC",
      fit: fitEnergyWindows([]),
    };
    await store.save(previous);
    const notes: unknown[] = [];
    const missing = createCorrectionRunner({
      store,
      env: {},
      load: async () => emptyHistory(),
      onError: (error) => notes.push(error),
    });
    missing.schedule();
    await missing.whenIdle();
    expect(await store.read()).toBe(previous);
    expect(notes).toEqual(["Set BIRTH_YEAR, SEX, and HEIGHT_IN or HEIGHT_CM in .env."]);

    const failure = new Error("db down");
    const broken = createCorrectionRunner({
      store,
      env: PROFILE,
      load: async () => {
        throw failure;
      },
      onError: (error) => notes.push(error),
    });
    broken.schedule({ timeZone: "UTC" });
    await broken.whenIdle();
    expect(await store.read()).toBe(previous);
    expect(notes[1]).toBe(failure);
  });

  it("uses a valid zone, then the stored zone, then the server zone", async () => {
    const store = new MemoryCorrectionStore();
    await store.save({
      updatedAt: new Date("2020-01-01T00:00:00.000Z"),
      timeZone: "America/Chicago",
      fit: fitEnergyWindows([]),
    });
    const runner = createCorrectionRunner({
      store,
      env: PROFILE,
      load: async () => emptyHistory(),
    });
    runner.schedule({ timeZone: "Not/AZone" });
    await runner.whenIdle();
    expect((await store.read())?.timeZone).toBe("America/Chicago");

    const fresh = new MemoryCorrectionStore();
    const fallback = createCorrectionRunner({
      store: fresh,
      env: PROFILE,
      load: async () => emptyHistory(),
    });
    fallback.schedule({ timeZone: "nope" });
    await fallback.whenIdle();
    expect((await fresh.read())?.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("recognizes a weigh-in and fits the stored history", async () => {
    expect(
      isWeighIn({
        observation: { at: new Date(), values: [{ fieldId: "weight", value: 80 }] },
        kind: { label: "weight", fields: [{ id: "weight", label: "weight", type: "number", unit: "kg" }] },
      }),
    ).toBe(true);
    expect(
      isWeighIn({
        observation: { at: new Date(), values: [{ fieldId: "course", value: "gone" }] },
        kind: { label: "Migraine", fields: [{ id: "course", label: "Course", type: "enum" }] },
      }),
    ).toBe(false);

    const foodStore = new MemoryFoodStore();
    const logger = new FoodLogger({
      fdc: { searchFoods: async () => ({ foods: [] }), getFood: async () => { throw new Error("unused"); } },
      ai: { parseQuery: async () => ({ items: [] }), selectMatch: async () => { throw new Error("unused"); } },
      queryCache: new MemoryCacheStore(),
      foodStore,
    });
    const journal = new Journal(new MemoryJournalStore());
    const start = Date.UTC(2026, 0, 5);
    for (let day = 0; day < 7; day += 1) {
      const eatenAt = new Date(start + day * 24 * 60 * 60 * 1000 + 16 * 60 * 60 * 1000);
      await foodStore.insert({
        eatenAt,
        createdAt: eatenAt,
        query: "banana",
        description: "banana",
        macros: MACROS,
        items: [{ name: "banana", fdcId: 1, description: "Bananas, raw", dataType: "SR Legacy", grams: 118, servingDescription: "1 banana", macros: MACROS }],
      });
    }
    const first = await journal.log({
      at: new Date(start + 12 * 60 * 60 * 1000),
      kind: { label: "weight", fields: [{ label: "weight", type: "number", unit: "kg" }] },
      values: [{ fieldId: "weight", value: 80 }],
    });
    await journal.log({
      at: new Date(start + 7 * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000),
      kindId: first.kind._id.toHexString(),
      values: [{ fieldId: "weight", value: 79 }],
    });

    const store = new MemoryCorrectionStore();
    const runner = createCorrectionRunner({
      store,
      env: PROFILE,
      load: () => loadHistory(logger, journal, new Date("2026-09-21T00:00:00.000Z")),
    });
    runner.schedule({ timeZone: "UTC" });
    await runner.whenIdle();
    const saved = await store.read();
    expect(saved?.fit.fitted).toBe(true);
    expect(saved?.fit.windowCount).toBe(1);
    expect(saved?.fit.expenditureFactor).toBeGreaterThan(0);
  });
});
