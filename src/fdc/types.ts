/** USDA FoodData Central data types. */
export const FDC_DATA_TYPES = [
  "Branded",
  "Foundation",
  "Survey (FNDDS)",
  "SR Legacy",
] as const;

export type FdcDataType = (typeof FDC_DATA_TYPES)[number];

export type FoodFormat = "abridged" | "full";

export type FoodSortBy =
  | "dataType.keyword"
  | "lowercaseDescription.keyword"
  | "fdcId"
  | "publishedDate";

export type SortOrder = "asc" | "desc";

export interface AbridgedFoodNutrient {
  /** Nutrient number; the live API returns a string even though the spec says integer. */
  number?: string | number;
  name?: string;
  amount?: number;
  unitName?: string;
  derivationCode?: string;
  derivationDescription?: string;
}

export interface Nutrient {
  id?: number;
  number?: string;
  name?: string;
  rank?: number;
  unitName?: string;
}

export interface FoodNutrientSource {
  id?: number;
  code?: string;
  description?: string;
}

export interface FoodNutrientDerivation {
  id?: number;
  code?: string;
  description?: string;
  foodNutrientSource?: FoodNutrientSource;
}

export interface NutrientAcquisitionDetails {
  sampleUnitId?: number;
  purchaseDate?: string;
  storeCity?: string;
  storeState?: string;
}

export interface NutrientAnalysisDetails {
  subSampleId?: number;
  amount?: number;
  nutrientId?: number;
  labMethodDescription?: string;
  labMethodOriginalDescription?: string;
  labMethodLink?: string;
  labMethodTechnique?: string;
  nutrientAcquisitionDetails?: NutrientAcquisitionDetails[];
}

export interface FoodNutrient {
  id?: number;
  amount?: number;
  dataPoints?: number;
  min?: number;
  max?: number;
  median?: number;
  type?: string;
  nutrient?: Nutrient;
  foodNutrientDerivation?: FoodNutrientDerivation;
  nutrientAnalysisDetails?: NutrientAnalysisDetails;
}

export interface LabelNutrientValue {
  value?: number;
}

export interface LabelNutrients {
  fat?: LabelNutrientValue;
  saturatedFat?: LabelNutrientValue;
  transFat?: LabelNutrientValue;
  cholesterol?: LabelNutrientValue;
  sodium?: LabelNutrientValue;
  carbohydrates?: LabelNutrientValue;
  fiber?: LabelNutrientValue;
  sugars?: LabelNutrientValue;
  protein?: LabelNutrientValue;
  calcium?: LabelNutrientValue;
  iron?: LabelNutrientValue;
  potassium?: LabelNutrientValue;
  /** Spec typo: `postassium`. */
  postassium?: LabelNutrientValue;
  calories?: LabelNutrientValue;
}

export interface FoodAttributeType {
  id?: number;
  name?: string;
  description?: string;
}

export interface FoodAttribute {
  id?: number;
  sequenceNumber?: number;
  value?: string;
  FoodAttributeType?: FoodAttributeType;
}

export interface FoodUpdateLog {
  fdcId?: number;
  availableDate?: string;
  brandOwner?: string;
  dataSource?: string;
  dataType?: string;
  description?: string;
  foodClass?: string;
  gtinUpc?: string;
  householdServingFullText?: string;
  ingredients?: string;
  modifiedDate?: string;
  publicationDate?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  brandedFoodCategory?: string;
  changes?: string;
  foodAttributes?: FoodAttribute[];
}

export interface FoodCategory {
  id?: number;
  code?: string;
  description?: string;
}

export interface FoodComponent {
  id?: number;
  name?: string;
  dataPoints?: number;
  gramWeight?: number;
  isRefuse?: boolean;
  minYearAcquired?: number;
  percentWeight?: number;
}

export interface MeasureUnit {
  id?: number;
  abbreviation?: string;
  name?: string;
}

export interface FoodPortion {
  id?: number;
  amount?: number;
  dataPoints?: number;
  gramWeight?: number;
  minYearAcquired?: number;
  modifier?: string;
  portionDescription?: string;
  sequenceNumber?: number;
  measureUnit?: MeasureUnit;
}

export interface NutrientConversionFactors {
  type?: string;
  value?: number;
}

export interface SampleFoodItem {
  fdcId: number;
  dataType?: string;
  description: string;
  foodClass?: string;
  publicationDate?: string;
  foodAttributes?: FoodCategory[];
}

export interface InputFoodFoundation {
  id?: number;
  foodDescription?: string;
  inputFood?: SampleFoodItem;
}

export interface RetentionFactor {
  id?: number;
  code?: number;
  description?: string;
}

export interface InputFoodSurvey {
  id?: number;
  amount?: number;
  foodDescription?: string;
  ingredientCode?: number;
  ingredientDescription?: string;
  ingredientWeight?: number;
  portionCode?: string;
  portionDescription?: string;
  sequenceNumber?: number;
  surveyFlag?: number;
  unit?: string;
  inputFood?: SurveyFoodItem;
  retentionFactor?: RetentionFactor;
}

export interface WweiaFoodCategory {
  wweiaFoodCategoryCode?: number;
  wweiaFoodCategoryDescription?: string;
}

export interface AbridgedFoodItem {
  fdcId: number;
  dataType: string;
  description: string;
  foodNutrients?: AbridgedFoodNutrient[];
  publicationDate?: string;
  brandOwner?: string;
  gtinUpc?: string;
  ndbNumber?: string | number;
  foodCode?: string;
}

export interface BrandedFoodItem {
  fdcId: number;
  dataType: "Branded" | string;
  description: string;
  availableDate?: string;
  brandOwner?: string;
  brandName?: string;
  dataSource?: string;
  foodClass?: string;
  gtinUpc?: string;
  householdServingFullText?: string;
  ingredients?: string;
  modifiedDate?: string;
  publicationDate?: string;
  servingSize?: number;
  servingSizeUnit?: string;
  brandedFoodCategory?: string;
  packageWeight?: string;
  marketCountry?: string;
  tradeChannels?: string[];
  foodNutrients?: FoodNutrient[];
  foodUpdateLog?: FoodUpdateLog[];
  labelNutrients?: LabelNutrients;
}

export interface FoundationFoodItem {
  fdcId: number;
  dataType: "Foundation" | string;
  description: string;
  foodClass?: string;
  footNote?: string;
  isHistoricalReference?: boolean;
  ndbNumber?: string | number;
  publicationDate?: string;
  scientificName?: string;
  foodCategory?: FoodCategory;
  foodComponents?: FoodComponent[];
  foodNutrients?: FoodNutrient[];
  foodPortions?: FoodPortion[];
  inputFoods?: InputFoodFoundation[];
  nutrientConversionFactors?: NutrientConversionFactors[];
}

export interface SRLegacyFoodItem {
  fdcId: number;
  dataType: "SR Legacy" | string;
  description: string;
  foodClass?: string;
  isHistoricalReference?: boolean;
  ndbNumber?: string | number;
  publicationDate?: string;
  scientificName?: string;
  foodCategory?: FoodCategory;
  foodNutrients?: FoodNutrient[];
  nutrientConversionFactors?: NutrientConversionFactors[];
}

export interface SurveyFoodItem {
  fdcId: number;
  dataType: "Survey (FNDDS)" | string;
  description: string;
  endDate?: string;
  foodClass?: string;
  foodCode?: string;
  publicationDate?: string;
  startDate?: string;
  foodAttributes?: FoodAttribute[];
  foodNutrients?: FoodNutrient[];
  foodPortions?: FoodPortion[];
  inputFoods?: InputFoodSurvey[];
  wweiaFoodCategory?: WweiaFoodCategory;
}

export type FoodItem =
  | AbridgedFoodItem
  | BrandedFoodItem
  | FoundationFoodItem
  | SRLegacyFoodItem
  | SurveyFoodItem;

export interface FoodsCriteria {
  fdcIds: number[];
  format?: FoodFormat;
  nutrients?: number[];
}

export interface FoodListCriteria {
  dataType?: FdcDataType[];
  pageSize?: number;
  pageNumber?: number;
  sortBy?: FoodSortBy;
  sortOrder?: SortOrder;
}

export interface FoodSearchCriteria {
  query: string;
  dataType?: FdcDataType[];
  pageSize?: number;
  pageNumber?: number;
  sortBy?: FoodSortBy;
  sortOrder?: SortOrder;
  brandOwner?: string;
}

/** Nutrient object as returned by `/foods/search` (differs from abridged food details). */
export interface SearchFoodNutrient {
  nutrientId?: number;
  nutrientName?: string;
  nutrientNumber?: string;
  unitName?: string;
  value?: number;
  derivationCode?: string;
  derivationDescription?: string;
  derivationId?: number;
  foodNutrientSourceId?: number;
  foodNutrientSourceCode?: string;
  foodNutrientSourceDescription?: string;
  rank?: number;
  indentLevel?: number;
  foodNutrientId?: number;
  percentDailyValue?: number;
}

export interface SearchResultFood {
  fdcId: number;
  description: string;
  dataType?: string;
  foodCode?: string;
  foodNutrients?: SearchFoodNutrient[];
  publicationDate?: string;
  publishedDate?: string;
  scientificName?: string;
  brandOwner?: string;
  brandName?: string;
  gtinUpc?: string;
  ingredients?: string;
  ndbNumber?: string | number;
  additionalDescriptions?: string;
  allHighlightFields?: string;
  score?: number;
  foodCategory?: string;
  modifiedDate?: string;
  dataSource?: string;
  packageWeight?: string;
  servingSizeUnit?: string;
  servingSize?: number;
  householdServingFullText?: string;
  marketCountry?: string;
  tradeChannels?: string[];
  microbes?: unknown[];
  finalFoodInputFoods?: unknown[];
  foodMeasures?: unknown[];
  foodAttributes?: unknown[];
  foodAttributeTypes?: unknown[];
  foodVersionIds?: unknown[];
}

export interface SearchResult {
  foodSearchCriteria?: FoodSearchCriteria & Record<string, unknown>;
  totalHits?: number;
  currentPage?: number;
  totalPages?: number;
  pageList?: number[];
  foods?: SearchResultFood[];
  aggregations?: {
    dataType?: Record<string, number>;
    nutrients?: Record<string, unknown>;
  };
}

export interface GetFoodOptions {
  format?: FoodFormat;
  /** Up to 25 nutrient numbers. */
  nutrients?: number[];
  skipCache?: boolean;
}

export interface GetFoodsOptions extends GetFoodOptions {}

export interface ListFoodsOptions extends FoodListCriteria {
  skipCache?: boolean;
}

export interface SearchFoodsOptions extends FoodSearchCriteria {
  skipCache?: boolean;
}

export interface FdcRateLimitInfo {
  limit: number;
  remaining: number | null;
  blockedUntil: Date | null;
}
