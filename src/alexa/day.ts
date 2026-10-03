/** UTC instant of local midnight in `timeZone` for the local day that contains `now`. */
export function startOfLocalDay(now: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const value = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  const offset = asUtc - now.getTime();
  return new Date(Date.UTC(value("year"), value("month") - 1, value("day")) - offset);
}

export function addDays(day: Date, days: number): Date {
  return new Date(day.getTime() + days * 24 * 60 * 60 * 1000);
}
