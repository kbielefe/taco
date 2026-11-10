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

/** A short relative age, such as "2 days ago". */
export function formatAgo(then: Date, now = new Date()): string {
  const elapsed = now.getTime() - then.getTime();
  if (!Number.isFinite(elapsed) || elapsed < 45_000) {
    return "just now";
  }
  const days = calendarDaysBetween(then, now);
  if (days >= 365) {
    const years = Math.floor(days / 365);
    return years === 1 ? "1 year ago" : `${years} years ago`;
  }
  if (days >= 30) {
    const months = Math.floor(days / 30);
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  if (days >= 14) {
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days >= 1) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) {
    const count = Math.max(1, minutes);
    return count === 1 ? "1 minute ago" : `${count} minutes ago`;
  }
  const hours = Math.floor(minutes / 60);
  return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
}

function calendarDaysBetween(then: Date, now: Date): number {
  const thenDay = Date.UTC(then.getFullYear(), then.getMonth(), then.getDate());
  const nowDay = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((nowDay - thenDay) / 86_400_000);
}

const EATING_DAY_START_MINUTES = 8 * 60 + 30;
const EATING_DAY_END_MINUTES = 22 * 60;

export function eatingDayFraction(now = new Date()): number {
  const minutes = now.getHours() * 60 + now.getMinutes();
  const span = EATING_DAY_END_MINUTES - EATING_DAY_START_MINUTES;
  return Math.min(1, Math.max(0, (minutes - EATING_DAY_START_MINUTES) / span));
}
