export interface Macros {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG: number;
}

export interface MealItem {
  name: string;
  fdcId: number;
  description: string;
  dataType: string;
  grams: number;
  servingDescription: string;
  macros: Macros;
}

export interface Meal {
  id: string;
  eatenAt: string;
  createdAt: string;
  query: string;
  description: string;
  macros: Macros;
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

export async function fetchMeals(from: Date, to: Date): Promise<{ meals: Meal[]; totals: Macros }> {
  const params = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  const response = await fetch(`/api/meals?${params}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<{ meals: Meal[]; totals: Macros }>;
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

export async function fetchSuggestions(query: string): Promise<Suggestion[]> {
  const response = await fetch(`/api/suggestions?${new URLSearchParams({ q: query })}`);
  if (!response.ok) {
    throw await readError(response);
  }
  const body = (await response.json()) as { suggestions: Suggestion[] };
  return body.suggestions;
}
