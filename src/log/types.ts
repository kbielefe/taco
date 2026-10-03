import type { ObjectId } from "mongodb";
import type { FdcDataType, FoodItem, GetFoodOptions, SearchFoodsOptions, SearchResult } from "../fdc/types.js";

export const FOOD_LOG_CACHE_SOURCE = "food-log";
export const QUERY_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_FOOD_LOG_MODEL = "grok-4.20-non-reasoning";
export const HEALTH_DB = "health";
export const FOOD_COLLECTION = "food";
export const CACHE_COLLECTION = "cache";

export interface FoodLogMacros {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG: number;
}

export interface FoodLogItem {
  name: string;
  fdcId: number;
  description: string;
  dataType: string;
  grams: number;
  servingDescription: string;
  macros: FoodLogMacros;
}

export interface FoodLogResolution {
  description: string;
  macros: FoodLogMacros;
  items: FoodLogItem[];
}

export interface FoodLogSuggestion {
  query: string;
  description: string;
  macros: FoodLogMacros;
}

export const SUGGEST_LIMIT = 8;

export interface FoodLogEntry extends FoodLogResolution {
  _id: ObjectId;
  eatenAt: Date;
  query: string;
  createdAt: Date;
}

export interface ParsedFoodItem {
  name: string;
  searchQueries: string[];
  brandOwner?: string;
  dataTypes?: FdcDataType[];
  servingHint: string;
  quantity: number;
}

export interface ParsedMeal {
  items: ParsedFoodItem[];
}

export interface MatchCandidate {
  fdcId: number;
  description: string;
  dataType?: string;
  brandOwner?: string;
  score?: number;
  servingSize?: number;
  servingSizeUnit?: string;
  householdServingFullText?: string;
  portions: { description: string; grams: number }[];
  suggestedGrams?: number;
}

export interface SelectMatchInput {
  mealQuery: string;
  item: ParsedFoodItem;
  candidates: MatchCandidate[];
}

export interface SelectedMatch {
  fdcId: number;
  grams: number;
  servingDescription: string;
}

export interface FoodLogAi {
  parseQuery(query: string): Promise<ParsedMeal>;
  selectMatch(input: SelectMatchInput): Promise<SelectedMatch>;
}

export interface FdcLookup {
  searchFoods(options: SearchFoodsOptions): Promise<SearchResult>;
  getFood(fdcId: number | string, options?: GetFoodOptions): Promise<FoodItem>;
}

export interface FoodStore {
  insert(entry: Omit<FoodLogEntry, "_id">): Promise<FoodLogEntry>;
  listByEatenAt(from: Date, to: Date): Promise<FoodLogEntry[]>;
  deleteById(id: string): Promise<boolean>;
}

export type FoodLogProgress = (message: string) => void | Promise<void>;

export interface LogFoodOptions {
  eatenAt?: Date;
  skipCache?: boolean;
  onProgress?: FoodLogProgress;
}
