export interface PaceMeter {
  scale: number;
  rangeStart: number;
  rangeEnd: number;
  now: number;
  day: number;
}

export function paceMeter(input: {
  eaten: number;
  minKcal: number;
  maxKcal: number;
  dayFraction: number;
}): PaceMeter {
  const scale = Math.max(input.maxKcal, input.eaten, 1);
  const pace = (input.minKcal + input.maxKcal) / 2;
  const place = (kcal: number): number => Math.min(1, Math.max(0, kcal / scale));
  return {
    scale,
    rangeStart: place(input.minKcal),
    rangeEnd: place(input.maxKcal),
    now: place(input.eaten),
    day: place(pace * input.dayFraction),
  };
}
