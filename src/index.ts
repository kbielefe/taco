export { createFdcClient, FdcClient } from "./fdc/client.js";
export type { CreateFdcClientOptions, FdcClientOptions } from "./fdc/client.js";
export {
  FdcAuthError,
  FdcBadRequestError,
  FdcConfigError,
  FdcError,
  FdcNetworkError,
  FdcNotFoundError,
  FdcRateLimitError,
  FdcResponseError,
  FdcServerError,
  FdcTimeoutError,
} from "./fdc/errors.js";
export {
  FOOD_CACHE_TTL_MS,
  MemoryCacheStore,
  MongoCacheStore,
  NOT_FOUND_CACHE_TTL_MS,
  SEARCH_CACHE_TTL_MS,
} from "./fdc/cache.js";
export type { CacheListEntry, CacheListOptions, CacheStore, FdcCacheDocument } from "./fdc/cache.js";
export { DEFAULT_HOURLY_LIMIT, DEMO_KEY_HOURLY_LIMIT, HourlyRateLimiter } from "./fdc/rate-limit.js";
export { FDC_DATA_TYPES } from "./fdc/types.js";
export type {
  AbridgedFoodItem,
  AbridgedFoodNutrient,
  BrandedFoodItem,
  FdcDataType,
  FdcRateLimitInfo,
  FoodFormat,
  FoodItem,
  FoodListCriteria,
  FoodNutrient,
  FoodSearchCriteria,
  FoodsCriteria,
  FoundationFoodItem,
  GetFoodOptions,
  GetFoodsOptions,
  ListFoodsOptions,
  SearchFoodsOptions,
  SearchResult,
  SearchResultFood,
  SRLegacyFoodItem,
  SurveyFoodItem,
} from "./fdc/types.js";
export { readBodyProfile } from "./energy/profile.js";
export type { ActivityLevel, BodyProfile, ProfileRead, Sex } from "./energy/profile.js";
export { recommendDay } from "./energy/recommend.js";
export type { DayRecommendation, IntakeSample, WeightObservation } from "./energy/recommend.js";
export { createJournal, Journal } from "./journal/journal.js";
export type { AppendKindInput, CreateJournalOptions, JournalKindView, JournalObservationView, LogJournalInput, NewKindInput } from "./journal/journal.js";
export { JournalConflictError, JournalConfigError, JournalError, JournalNotFoundError, JournalValidationError } from "./journal/errors.js";
export { MemoryJournalStore, MongoJournalStore } from "./journal/store.js";
export { FIELD_TYPES, KINDS_COLLECTION, OBSERVATIONS_COLLECTION, TEXT_SUGGESTION_LIMIT } from "./journal/types.js";
export type {
  FieldType,
  FieldValue,
  JournalField,
  JournalFieldValue,
  JournalKind,
  JournalObservation,
  JournalStore,
} from "./journal/types.js";
export { createFoodLogger, FoodLogger } from "./log/logger.js";
export type { CreateFoodLoggerOptions, FoodLoggerOptions } from "./log/logger.js";
export { XaiFoodLogAi } from "./log/ai.js";
export type { XaiFoodLogAiOptions } from "./log/ai.js";
export { MemoryFoodStore, MongoFoodStore } from "./log/store.js";
export { FoodLogAiError, FoodLogConfigError, FoodLogError, FoodLogMatchError } from "./log/errors.js";
export { DEFAULT_FOOD_LOG_MODEL, FOOD_LOG_CACHE_SOURCE, QUERY_CACHE_TTL_MS, SUGGEST_LIMIT } from "./log/types.js";
export type {
  FdcLookup,
  FoodLogAi,
  FoodLogEntry,
  FoodLogItem,
  FoodLogMacros,
  FoodLogResolution,
  FoodLogSuggestion,
  FoodStore,
  FoodLogProgress,
  LogFoodOptions,
  MatchCandidate,
  ParsedFoodItem,
  ParsedMeal,
  SelectMatchInput,
  SelectedMatch,
} from "./log/types.js";
