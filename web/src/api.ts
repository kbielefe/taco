import { localTimeZone } from "./time.js";

export interface Macros {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG: number;
}

export interface ItemCorrection {
  factor: number;
  label: string;
}

export interface MealItem {
  name: string;
  fdcId: number;
  description: string;
  dataType: string;
  grams: number;
  servingDescription: string;
  macros: Macros;
  correction?: ItemCorrection;
}

export interface Meal {
  id: string;
  eatenAt: string;
  createdAt: string;
  query: string;
  description: string;
  macros: Macros;
  adjusted?: Macros;
  items: MealItem[];
}

export interface Suggestion {
  query: string;
  description: string;
  macros: Macros;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readError(response: Response): Promise<ApiError> {
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = (body as { error?: { message?: unknown } }).error;
      if (error && typeof error.message === "string") {
        return new ApiError(error.message, response.status);
      }
    }
  } catch {
    // fall through
  }
  return new ApiError("Something went wrong. Try again.", response.status);
}

export interface EnergyRecommendation {
  kcal: number | null;
  message: string;
  goal: "lose" | "maintain" | null;
  basis: "week" | "partial" | "body" | null;
  limitedByMinimum: boolean;
  minimumKcal: number | null;
  bmi: number | null;
}

export async function fetchEnergy(today: Date): Promise<EnergyRecommendation> {
  const params = new URLSearchParams({ today: today.toISOString() });
  const response = await fetch(`/api/recommendation?${params}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<EnergyRecommendation>;
}

export async function fetchMeals(
  from: Date,
  to: Date,
): Promise<{ meals: Meal[]; totals: Macros; correctionPending?: boolean }> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const response = await fetch(`/api/meals?${params}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<{ meals: Meal[]; totals: Macros; correctionPending?: boolean }>;
}

export async function logMeal(
  query: string,
  options: { onProgress?: (message: string) => void } = {},
): Promise<Meal> {
  const response = await fetch("/api/meals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
    },
    body: JSON.stringify({ query }),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("ndjson") && response.body) {
    return readMealLogNdjson(response.body, options.onProgress);
  }
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<Meal>;
}

async function readMealLogNdjson(
  body: ReadableStream<Uint8Array>,
  onProgress?: (message: string) => void,
): Promise<Meal> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let meal: Meal | undefined;
  let streamError: ApiError | undefined;

  const consume = (line: string): void => {
    const event = parseMealLogLine(line);
    if (!event) {
      return;
    }
    if (event.type === "progress") {
      onProgress?.(event.message);
      return;
    }
    if (event.type === "result") {
      meal = event.meal;
      return;
    }
    streamError = new ApiError(event.error.message, event.status ?? 500);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      consume(line);
    }
  }
  consume(buffer + decoder.decode());
  if (streamError) {
    throw streamError;
  }
  if (!meal) {
    throw new ApiError("Something went wrong. Try again.", 500);
  }
  return meal;
}

function parseMealLogLine(line: string):
  | { type: "progress"; message: string }
  | { type: "result"; meal: Meal }
  | { type: "error"; error: { message: string }; status?: number }
  | undefined {
  const trimmed = line.trim();
  if (trimmed === "") {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || !("type" in value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.type === "progress" && typeof record.message === "string") {
    return { type: "progress", message: record.message };
  }
  if (record.type === "result" && record.meal && typeof record.meal === "object") {
    return { type: "result", meal: record.meal as Meal };
  }
  if (record.type === "error") {
    const error = record.error;
    const message =
      error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "Something went wrong. Try again.";
    const status = typeof record.status === "number" ? record.status : undefined;
    return { type: "error", error: { message }, ...(status !== undefined ? { status } : {}) };
  }
  return undefined;
}

export async function deleteMeal(id: string): Promise<void> {
  const response = await fetch(`/api/meals/${id}`, { method: "DELETE" });
  if (!response.ok) {
    throw await readError(response);
  }
}

export type FieldType = "number" | "enum" | "text" | "boolean" | "event";

export interface JournalField {
  id: string;
  label: string;
  type: FieldType;
  unit?: string;
  options?: string[];
}

export interface JournalFieldInput {
  label: string;
  type: FieldType;
  unit?: string;
  options?: string[];
}

export interface JournalKind {
  id: string;
  label: string;
  fields: JournalField[];
  lastUsedAt: string | null;
  suggestions: Record<string, string[]>;
}

export interface JournalValue {
  fieldId: string;
  value: number | string | boolean;
}

export interface JournalEntry {
  id: string;
  at: string;
  createdAt: string;
  kind: { id: string; label: string; fields: JournalField[] };
  values: JournalValue[];
}

export async function fetchKinds(): Promise<JournalKind[]> {
  const response = await fetch("/api/journal/kinds");
  if (!response.ok) {
    throw await readError(response);
  }
  const body = (await response.json()) as { kinds: JournalKind[] };
  return body.kinds;
}

export async function fetchJournal(from: Date, to: Date): Promise<JournalEntry[]> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const response = await fetch(`/api/journal?${params}`);
  if (!response.ok) {
    throw await readError(response);
  }
  const body = (await response.json()) as { observations: JournalEntry[] };
  return body.observations;
}

export async function logJournal(body: {
  kindId?: string;
  kind?: { label: string; fields: JournalFieldInput[] };
  values: JournalValue[];
}): Promise<JournalEntry> {
  const response = await fetch("/api/journal", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, timeZone: localTimeZone() }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<JournalEntry>;
}

export async function appendKind(
  id: string,
  body: { addFields?: JournalFieldInput[]; addOptions?: { fieldId: string; options: string[] }[] },
): Promise<JournalKind> {
  const response = await fetch(`/api/journal/kinds/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<JournalKind>;
}

export async function deleteJournalEntry(id: string): Promise<void> {
  const params = new URLSearchParams({ timeZone: localTimeZone() });
  const response = await fetch(`/api/journal/${id}?${params}`, { method: "DELETE" });
  if (!response.ok) {
    throw await readError(response);
  }
}

export async function fetchSuggestions(query: string): Promise<Suggestion[]> {
  const response = await fetch(`/api/suggestions?${new URLSearchParams({ q: query })}`);
  if (!response.ok) {
    throw await readError(response);
  }
  const body = (await response.json()) as { suggestions: Suggestion[] };
  return body.suggestions;
}
