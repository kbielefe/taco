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

export async function logMeal(query: string): Promise<Meal> {
  const response = await fetch("/api/meals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return response.json() as Promise<Meal>;
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
