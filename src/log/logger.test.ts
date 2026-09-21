import { describe, expect, it, vi } from "vitest";
import { MemoryCacheStore } from "../fdc/cache.js";
import type { FoodItem, SearchResult, SearchResultFood } from "../fdc/types.js";
import { FoodLogAiError, FoodLogConfigError, FoodLogMatchError } from "./errors.js";
import { createFoodLogger, FoodLogger } from "./logger.js";
import { MemoryFoodStore } from "./store.js";
import type { FdcLookup, FoodLogAi, ParsedMeal, SelectMatchInput, SelectedMatch } from "./types.js";

function jsonFood(overrides: Partial<SearchResultFood> & Pick<SearchResultFood, "fdcId" | "description">): SearchResultFood {
  return {
    dataType: "SR Legacy",
    score: 100,
    ...overrides,
  };
}

function details(fdcId: number, description: string, calories: number, protein = 1, fat = 1, carb = 10, fiber = 1): FoodItem {
  return {
    fdcId,
    dataType: "SR Legacy",
    description,
    foodNutrients: [
      { amount: calories, nutrient: { id: 1008, number: "208", name: "Energy", unitName: "KCAL" } },
      { amount: protein, nutrient: { id: 1003, number: "203", name: "Protein", unitName: "G" } },
      { amount: fat, nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "G" } },
      { amount: carb, nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "G" } },
      { amount: fiber, nutrient: { id: 1079, number: "291", name: "Fiber, total dietary", unitName: "G" } },
    ],
  };
}

function meal(items: ParsedMeal["items"]): ParsedMeal {
  return { items };
}

function mockAi(parsed: ParsedMeal, match: SelectedMatch | ((input: SelectMatchInput) => SelectedMatch)): FoodLogAi {
  return {
    parseQuery: vi.fn(async () => parsed),
    selectMatch: vi.fn(async (input) => (typeof match === "function" ? match(input) : match)),
  };
}

function mockFdc(search: SearchResultFood[] | ((query: string) => SearchResultFood[]), foods: Record<number, FoodItem>): FdcLookup {
  return {
    searchFoods: vi.fn(async (options) => {
      const list = typeof search === "function" ? search(options.query) : search;
      return { foods: list } satisfies SearchResult;
    }),
    getFood: vi.fn(async (fdcId) => {
      const food = foods[Number(fdcId)];
      if (!food) {
        throw new Error(`missing food ${String(fdcId)}`);
      }
      return food;
    }),
  };
}

describe("FoodLogger", () => {
  it("resolves a cache miss, inserts food, and reuses the query cache", async () => {
    const cheerios = jsonFood({ fdcId: 10, description: "CHEERIOS", dataType: "Branded", servingSize: 28, servingSizeUnit: "g" });
    const milk = jsonFood({ fdcId: 20, description: "Milk, 2%", dataType: "Foundation" });
    const ai = mockAi(
      meal([
        {
          name: "Cheerios",
          searchQuery: "Cheerios",
          servingHint: "1 cup cereal",
          quantity: 1,
        },
        {
          name: "milk",
          searchQuery: "2% milk",
          servingHint: "1 cup milk",
          quantity: 1,
        },
      ]),
      (input) =>
        input.item.name === "Cheerios"
          ? { fdcId: 10, grams: 28, servingDescription: "1 cup" }
          : { fdcId: 20, grams: 244, servingDescription: "1 cup" },
    );
    const fdc = mockFdc(
      (query) => (query.toLowerCase().includes("cheerios") ? [cheerios] : [milk]),
      {
        10: details(10, "CHEERIOS", 100, 3, 2, 20, 3),
        20: details(20, "Milk, 2%", 50, 3.3, 2, 5, 0),
      },
    );
    const foodStore = new MemoryFoodStore();
    const queryCache = new MemoryCacheStore();
    const logger = new FoodLogger({ fdc, ai, queryCache, foodStore });

    const first = await logger.log("Cheerios and milk");
    const second = await logger.log("cheerios AND milk");

    expect(first.items).toHaveLength(2);
    expect(first.description).toContain("Cheerios");
    expect(first.macros.caloriesKcal).toBeGreaterThan(0);
    expect(foodStore.entries).toHaveLength(2);
    expect(second.items).toEqual(first.items);
    expect(second._id).not.toEqual(first._id);
    expect(ai.parseQuery).toHaveBeenCalledOnce();
    expect(ai.selectMatch).toHaveBeenCalledTimes(2);
    expect(fdc.searchFoods).toHaveBeenCalledTimes(2);
  });

  it("does not insert when FDC has no match", async () => {
    const ai = mockAi(
      meal([{ name: "mystery stew", searchQuery: "mystery stew", servingHint: "1 bowl", quantity: 1 }]),
      { fdcId: 1, grams: 100, servingDescription: "1 bowl" },
    );
    const fdc = mockFdc([], {});
    const foodStore = new MemoryFoodStore();
    const queryCache = new MemoryCacheStore();
    const logger = new FoodLogger({ fdc, ai, queryCache, foodStore });

    await expect(logger.log("mystery stew")).rejects.toBeInstanceOf(FoodLogMatchError);
    expect(foodStore.entries).toHaveLength(0);
    expect(await queryCache.get("food-log:v1:query:mystery stew")).toBeUndefined();
    expect(ai.selectMatch).not.toHaveBeenCalled();
  });

  it("retries an empty search with fallbackQuery", async () => {
    const banana = jsonFood({ fdcId: 1105073, description: "Bananas, raw", foodMeasures: [{ gramWeight: 118, disseminationText: "1 medium" }] });
    const ai = mockAi(
      meal([
        {
          name: "banana",
          searchQuery: "cavendish banana",
          fallbackQuery: "banana",
          servingHint: "1 medium banana",
          quantity: 1,
        },
      ]),
      { fdcId: 1105073, grams: 118, servingDescription: "1 medium banana" },
    );
    const fdc = mockFdc((query) => (query === "banana" ? [banana] : []), {
      1105073: details(1105073, "Bananas, raw", 89, 1.1, 0.3, 22.8, 2.6),
    });
    const logger = new FoodLogger({
      fdc,
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const entry = await logger.log("banana");
    expect(entry.items[0]?.fdcId).toBe(1105073);
    expect(fdc.searchFoods).toHaveBeenCalledTimes(2);
  });

  it("skipCache bypasses a stored resolution", async () => {
    const banana = jsonFood({ fdcId: 1, description: "Bananas, raw" });
    const ai = mockAi(
      meal([{ name: "banana", searchQuery: "banana", servingHint: "1 medium banana", quantity: 1 }]),
      { fdcId: 1, grams: 118, servingDescription: "1 medium banana" },
    );
    const fdc = mockFdc([banana], { 1: details(1, "Bananas, raw", 89) });
    const logger = new FoodLogger({
      fdc,
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    await logger.log("banana");
    await logger.log("banana", { skipCache: true });
    expect(ai.parseQuery).toHaveBeenCalledTimes(2);
  });

  it("rejects an empty query", async () => {
    const logger = new FoodLogger({
      fdc: mockFdc([], {}),
      ai: mockAi(meal([]), { fdcId: 1, grams: 1, servingDescription: "x" }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    await expect(logger.log("   ")).rejects.toBeInstanceOf(FoodLogConfigError);
  });

  it("rejects a selected fdcId that was not a candidate", async () => {
    const ai = mockAi(
      meal([{ name: "banana", searchQuery: "banana", servingHint: "1 banana", quantity: 1 }]),
      { fdcId: 999, grams: 100, servingDescription: "1 banana" },
    );
    const fdc = mockFdc([jsonFood({ fdcId: 1, description: "Bananas, raw" })], {
      1: details(1, "Bananas, raw", 89),
    });
    const foodStore = new MemoryFoodStore();
    const logger = new FoodLogger({ fdc, ai, queryCache: new MemoryCacheStore(), foodStore });
    await expect(logger.log("banana")).rejects.toBeInstanceOf(FoodLogAiError);
    expect(foodStore.entries).toHaveLength(0);
  });
});

describe("createFoodLogger", () => {
  it("does not require env when dependencies are injected", async () => {
    const logger = await createFoodLogger({
      ai: mockAi(meal([{ name: "banana", searchQuery: "banana", servingHint: "1 banana", quantity: 1 }]), {
        fdcId: 1,
        grams: 118,
        servingDescription: "1 banana",
      }),
      fdc: mockFdc([jsonFood({ fdcId: 1, description: "Bananas, raw" })], {
        1: details(1, "Bananas, raw", 89),
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });
    const entry = await logger.log("banana");
    expect(entry.query).toBe("banana");
    await logger.close();
  });

  it("throws when Mongo is needed but MONGODB_URI is unset", async () => {
    const previous = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;
    const previousXai = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = "test-xai";
    try {
      await expect(createFoodLogger({ ai: mockAi(meal([]), { fdcId: 1, grams: 1, servingDescription: "x" }) })).rejects.toBeInstanceOf(
        FoodLogConfigError,
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MONGODB_URI;
      } else {
        process.env.MONGODB_URI = previous;
      }
      if (previousXai === undefined) {
        delete process.env.XAI_API_KEY;
      } else {
        process.env.XAI_API_KEY = previousXai;
      }
    }
  });
});
