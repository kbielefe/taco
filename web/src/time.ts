export function localDayRange(now = new Date()): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

export function formatDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(date);
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const EATING_DAY_START_MINUTES = 8 * 60 + 30;
const EATING_DAY_END_MINUTES = 22 * 60;

export function eatingDayFraction(now = new Date()): number {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const span = EATING_DAY_END_MINUTES - EATING_DAY_START_MINUTES;
  return Math.min(1, Math.max(0, (minutes - EATING_DAY_START_MINUTES) / span));
}
