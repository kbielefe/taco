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
          searchQueries: ["Cheerios"],
          servingHint: "1 cup cereal",
          quantity: 1,
        },
        {
          name: "milk",
          searchQueries: ["2% milk"],
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
    expect(fdc.searchFoods).toHaveBeenCalledTimes(3);

    const cached = await queryCache.get<{ query: string }>("food-log:v1:query:cheerios and milk");
    expect(cached?.query).toBe("Cheerios and milk");
    const suggestions = await logger.suggest("cheer");
    expect(suggestions[0]?.query).toBe("Cheerios and milk");
  });

  it("logs a branded drink when getFood omits nutrient identity", async () => {
    const searchHit = jsonFood({
      fdcId: 2742717,
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      dataType: "Branded",
      servingSize: 355,
      servingSizeUnit: "MLT",
      foodNutrients: [
        { nutrientId: 1008, nutrientNumber: "208", nutrientName: "Energy", unitName: "KCAL", value: 0 },
        { nutrientId: 1003, nutrientNumber: "203", nutrientName: "Protein", unitName: "G", value: 0 },
        { nutrientId: 1004, nutrientNumber: "204", nutrientName: "Total lipid (fat)", unitName: "G", value: 0 },
        { nutrientId: 1005, nutrientNumber: "205", nutrientName: "Carbohydrate, by difference", unitName: "G", value: 0 },
      ],
    });
    const gdsnDetails = {
      fdcId: 2742717,
      dataType: "Branded",
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      servingSize: 355,
      servingSizeUnit: "MLT",
      foodNutrients: [
        { type: "FoodNutrient", id: 34890924, amount: 0 },
        { type: "FoodNutrient", id: 34890931, amount: 11 },
      ],
      labelNutrients: {},
    } as FoodItem;
    const ai = mockAi(
      meal([
        {
          name: "Coke Zero",
          searchQueries: ["Coca-Cola Zero Sugar"],
          servingHint: "1 can",
          quantity: 1,
        },
      ]),
      { fdcId: 2742717, grams: 355, servingDescription: "1 can" },
    );
    const fdc = mockFdc([searchHit], { 2742717: gdsnDetails });
    const foodStore = new MemoryFoodStore();
    const logger = new FoodLogger({
      fdc,
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore,
    });

    const messages: string[] = [];
    const entry = await logger.log("coke zero", { onProgress: (message) => messages.push(message) });
    expect(entry.macros).toEqual({ caloriesKcal: 0, proteinG: 0, fatG: 0, carbG: 0, fiberG: 0 });
    expect(messages).not.toContain("Loading extra nutrition details.");
    expect(entry.items[0]?.fdcId).toBe(2742717);
    expect(foodStore.entries).toHaveLength(1);
    expect(fdc.getFood).toHaveBeenCalledOnce();
  });

  it("reports extra nutrition details when the food payload needs an abridged fetch", async () => {
    const searchHit = jsonFood({ fdcId: 1, description: "GDSN drink", dataType: "Branded" });
    const gdsn = {
      fdcId: 1,
      dataType: "Branded",
      description: "GDSN drink",
      foodNutrients: [{ type: "FoodNutrient", id: 1, amount: 0 }],
      labelNutrients: {},
    } as FoodItem;
    const logger = new FoodLogger({
      fdc: {
        searchFoods: vi.fn(async () => ({ foods: [searchHit] })),
        getFood: vi.fn(async (_id, options) => (options?.format === "abridged" ? details(1, "GDSN drink", 0, 0, 0, 0, 0) : gdsn)),
      },
      ai: mockAi(meal([{ name: "drink", searchQueries: ["drink"], servingHint: "1 can", quantity: 1 }]), {
        fdcId: 1,
        grams: 355,
        servingDescription: "1 can",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const messages: string[] = [];
    await logger.log("drink", { onProgress: (message) => messages.push(message) });
    expect(messages).toEqual([
      "Parsing meal.",
      "Running 1 FDC search.",
      "Picking a match.",
      "Loading nutrition.",
      "Loading extra nutrition details.",
      "Saving meal.",
    ]);
  });

  it("does not insert when FDC has no match", async () => {
    const ai = mockAi(
      meal([{ name: "mystery stew", searchQueries: ["mystery stew"], servingHint: "1 bowl", quantity: 1 }]),
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

  it("searches all queries in parallel and reranks so a later query can win", async () => {
    const dietCoke = jsonFood({ fdcId: 2742339, description: "Diet Coke Bottle, 1.25 Liters", dataType: "Branded", score: 900 });
    const cokeZero = jsonFood({
      fdcId: 2742717,
      description: "Coca-Cola Zero Sugar Can, 12 fl oz",
      dataType: "Branded",
      score: 200,
      foodNutrients: [
        { nutrientId: 1008, nutrientNumber: "208", nutrientName: "Energy", unitName: "KCAL", value: 0 },
        { nutrientId: 1003, nutrientNumber: "203", nutrientName: "Protein", unitName: "G", value: 0 },
        { nutrientId: 1004, nutrientNumber: "204", nutrientName: "Total lipid (fat)", unitName: "G", value: 0 },
        { nutrientId: 1005, nutrientNumber: "205", nutrientName: "Carbohydrate, by difference", unitName: "G", value: 0 },
      ],
    });
    const ai = mockAi(
      meal([
        {
          name: "Coke Zero",
          searchQueries: ["coke zero", "Coca-Cola Zero Sugar", "Coke Zero Sugar"],
          servingHint: "1 can",
          quantity: 1,
        },
      ]),
      (input) => {
        expect(input.candidates[0]?.fdcId).toBe(2742717);
        const ids = input.candidates.map((candidate) => candidate.fdcId);
        expect(ids).toContain(2742339);
        expect(ids).toContain(2742717);
        return { fdcId: 2742717, grams: 355, servingDescription: "1 can" };
      },
    );
    const fdc = mockFdc(
      (query) => (query.toLowerCase().includes("zero sugar") ? [cokeZero] : [dietCoke]),
      {
        2742717: {
          fdcId: 2742717,
          dataType: "Branded",
          description: "Coca-Cola Zero Sugar Can, 12 fl oz",
          foodNutrients: [{ type: "FoodNutrient", id: 34890924, amount: 0 }],
          labelNutrients: {},
        } as FoodItem,
      },
    );
    const logger = new FoodLogger({
      fdc,
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const entry = await logger.log("coke zero");
    expect(entry.items[0]?.fdcId).toBe(2742717);
    expect(fdc.searchFoods).toHaveBeenCalledTimes(3);
  });

  it("merges hits when some queries miss", async () => {
    const banana = jsonFood({ fdcId: 1105073, description: "Bananas, raw", foodMeasures: [{ gramWeight: 118, disseminationText: "1 medium" }] });
    const ai = mockAi(
      meal([
        {
          name: "banana",
          searchQueries: ["cavendish banana", "banana"],
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
      meal([{ name: "banana", searchQueries: ["banana"], servingHint: "1 medium banana", quantity: 1 }]),
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

  it("reports high-level progress for a cache miss and a later cache hit", async () => {
    const banana = jsonFood({ fdcId: 1, description: "Bananas, raw" });
    const logger = new FoodLogger({
      fdc: mockFdc([banana], { 1: details(1, "Bananas, raw", 89) }),
      ai: mockAi(meal([{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }]), {
        fdcId: 1,
        grams: 118,
        servingDescription: "1 banana",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const miss: string[] = [];
    await logger.log("banana", { onProgress: (message) => miss.push(message) });
    expect(miss).toEqual([
      "Parsing meal.",
      "Running 1 FDC search.",
      "Picking a match.",
      "Loading nutrition.",
      "Saving meal.",
    ]);

    const hit: string[] = [];
    await logger.log("banana", { onProgress: (message) => hit.push(message) });
    expect(hit).toEqual(["Using a previous match.", "Saving meal."]);
  });

  it("counts every FDC search and match in progress updates", async () => {
    const cheerios = jsonFood({ fdcId: 10, description: "CHEERIOS", dataType: "Branded", servingSize: 28, servingSizeUnit: "g" });
    const milk = jsonFood({ fdcId: 20, description: "Milk, 2%", dataType: "Foundation" });
    const logger = new FoodLogger({
      fdc: mockFdc(
        (query) => (query.toLowerCase().includes("cheerios") ? [cheerios] : [milk]),
        {
          10: details(10, "CHEERIOS", 100, 3, 2, 20, 3),
          20: details(20, "Milk, 2%", 50, 3.3, 2, 5, 0),
        },
      ),
      ai: mockAi(
        meal([
          { name: "Cheerios", searchQueries: ["Cheerios"], servingHint: "1 cup cereal", quantity: 1 },
          { name: "milk", searchQueries: ["2% milk"], servingHint: "1 cup milk", quantity: 1 },
        ]),
        (input) =>
          input.item.name === "Cheerios"
            ? { fdcId: 10, grams: 28, servingDescription: "1 cup" }
            : { fdcId: 20, grams: 244, servingDescription: "1 cup" },
      ),
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const messages: string[] = [];
    await logger.log("Cheerios and milk", { onProgress: (message) => messages.push(message) });
    expect(messages).toEqual([
      "Parsing meal.",
      "Running 3 FDC searches.",
      "Picking 2 matches.",
      "Loading nutrition for 2 foods.",
      "Saving meal.",
    ]);
  });

  it("lists and deletes stored meals", async () => {
    const banana = jsonFood({ fdcId: 1, description: "Bananas, raw" });
    const foodStore = new MemoryFoodStore();
    const logger = new FoodLogger({
      fdc: mockFdc([banana], { 1: details(1, "Bananas, raw", 89) }),
      ai: mockAi(meal([{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }]), {
        fdcId: 1,
        grams: 118,
        servingDescription: "1 banana",
      }),
      queryCache: new MemoryCacheStore(),
      foodStore,
    });

    const first = await logger.log("banana", { eatenAt: new Date("2026-09-20T08:00:00Z") });
    await logger.log("banana", { eatenAt: new Date("2026-09-20T12:00:00Z") });
    await logger.log("banana", { eatenAt: new Date("2026-09-21T08:00:00Z") });

    const today = await logger.list(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"));
    expect(today).toHaveLength(2);
    expect(await logger.delete(first._id.toString())).toBe(true);
    expect(await logger.list(new Date("2026-09-20T00:00:00Z"), new Date("2026-09-21T00:00:00Z"))).toHaveLength(1);
  });

  it("logs a leading count as the food with that quantity", async () => {
    const rice = jsonFood({ fdcId: 7, description: "Rice, fried", servingSize: 200, servingSizeUnit: "g" });
    const ai = mockAi(
      meal([{ name: "Rice, fried", searchQueries: ["fried rice"], servingHint: "1 cup", quantity: 4 }]),
      { fdcId: 7, grams: 200, servingDescription: "1 cup" },
    );
    const fdc = mockFdc([rice], { 7: details(7, "Rice, fried", 100) });
    const foodStore = new MemoryFoodStore();
    const logger = new FoodLogger({ fdc, ai, queryCache: new MemoryCacheStore(), foodStore });

    const entry = await logger.log("2 fried rice");
    const again = await logger.log("3 fried rice");

    expect(ai.parseQuery).toHaveBeenCalledExactlyOnceWith("fried rice");
    expect(ai.selectMatch).toHaveBeenCalledOnce();
    expect(ai.selectMatch).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ quantity: 1 }) }));
    expect(entry.query).toBe("fried rice");
    expect(entry.servings).toBe(2);
    expect(entry.items[0]).toMatchObject({ name: "fried rice", grams: 200 });
    expect(entry.macros.caloriesKcal).toBe(200);
    expect(entry.description).toBe("fried rice (1 cup)");
    expect(again.servings).toBe(3);
    expect(again.macros).toEqual(entry.macros);
    expect(foodStore.entries).toHaveLength(2);
  });

  it("keeps a measured amount on the food instead of the quantity", async () => {
    const ai = mockAi(
      meal([{ name: "rice", searchQueries: ["rice"], servingHint: "2 cups", quantity: 1 }]),
      { fdcId: 7, grams: 316, servingDescription: "2 cups" },
    );
    const logger = new FoodLogger({
      fdc: mockFdc([jsonFood({ fdcId: 7, description: "Rice, white" })], { 7: details(7, "Rice, white", 130) }),
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const entry = await logger.log("2 cups of fried rice");
    expect(ai.parseQuery).toHaveBeenCalledExactlyOnceWith("2 cups of fried rice");
    expect(entry.servings).toBeUndefined();
    expect(entry.query).toBe("2 cups of fried rice");
  });

  it("lets a leading count on a joined meal apply to the first food", async () => {
    const banana = { name: "bananas", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 };
    const milk = { name: "milk", searchQueries: ["milk"], servingHint: "1 cup", quantity: 1 };
    const ai: FoodLogAi = {
      parseQuery: vi.fn(async (query: string) => {
        if (query === "bananas and milk") {
          return meal([banana, milk]);
        }
        if (query === "2 bananas and milk") {
          return meal([{ ...banana, quantity: 2 }, milk]);
        }
        throw new Error(`unexpected query ${query}`);
      }),
      selectMatch: vi.fn(async (input: SelectMatchInput) =>
        input.item.name === "milk"
          ? { fdcId: 20, grams: 244, servingDescription: "1 cup" }
          : { fdcId: 10, grams: input.item.quantity * 118, servingDescription: "1 banana" },
      ),
    };
    const logger = new FoodLogger({
      fdc: mockFdc(
        (query) =>
          query.toLowerCase().includes("milk")
            ? [jsonFood({ fdcId: 20, description: "Milk" })]
            : [jsonFood({ fdcId: 10, description: "Bananas, raw" })],
        { 10: details(10, "Bananas, raw", 89), 20: details(20, "Milk", 50) },
      ),
      ai,
      queryCache: new MemoryCacheStore(),
      foodStore: new MemoryFoodStore(),
    });

    const entry = await logger.log("2 bananas and milk");
    expect(ai.parseQuery).toHaveBeenCalledTimes(2);
    expect(ai.parseQuery).toHaveBeenNthCalledWith(1, "bananas and milk");
    expect(ai.parseQuery).toHaveBeenNthCalledWith(2, "2 bananas and milk");
    expect(entry.query).toBe("2 bananas and milk");
    expect(entry.servings).toBeUndefined();
    expect(entry.items.map((item) => ({ name: item.name, grams: item.grams }))).toEqual([
      { name: "bananas", grams: 236 },
      { name: "milk", grams: 244 },
    ]);
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
      meal([{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }]),
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
      ai: mockAi(meal([{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }]), {
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
