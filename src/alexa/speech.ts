export interface TodaySnapshot {
  caloriesKcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  fiberG: number;
  minKcal: number | null;
  maxKcal: number | null;
}

export function helpText(): string {
  return "You can tell me what you ate, or ask how today is going.";
}

export function remainingPhrase(eaten: number, minKcal: number | null, maxKcal: number | null): string {
  if (minKcal === null || maxKcal === null) {
    return "";
  }
  if (eaten > maxKcal) {
    return `${eaten - maxKcal} over`;
  }
  if (minKcal !== maxKcal && eaten < minKcal) {
    return `${minKcal - eaten} to ${maxKcal - eaten} left`;
  }
  return `${maxKcal - eaten} left`;
}

export function todaySpeech(today: TodaySnapshot): string {
  const grams = (value: number): number => Math.round(value);
  const remaining = remainingPhrase(today.caloriesKcal, today.minKcal, today.maxKcal);
  const summary = `You've had ${today.caloriesKcal} calories, ${grams(today.proteinG)} grams of protein, ${grams(today.fatG)} grams of fat, ${grams(today.carbG)} grams of carbohydrate, and ${grams(today.fiberG)} grams of fiber.`;
  return remaining === "" ? summary : `${summary} About ${remaining}.`;
}

export function loggedSpeech(description: string, mealKcal: number, today: TodaySnapshot): string {
  const remaining = remainingPhrase(today.caloriesKcal, today.minKcal, today.maxKcal);
  const head = `Logged ${description}, ${mealKcal} calories. You've had ${today.caloriesKcal} today`;
  return remaining === "" ? `${head}.` : `${head}, about ${remaining}.`;
}

export function stillLoggingSpeech(query: string): string {
  return `I'm logging ${query}. Ask me again in a moment.`;
}
