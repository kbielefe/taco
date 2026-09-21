import { FdcRateLimitError } from "./errors.js";
import type { FdcRateLimitInfo } from "./types.js";

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_HOURLY_LIMIT = 1000;
export const DEMO_KEY_HOURLY_LIMIT = 30;
/** Keep a small buffer so we never send the request that trips the 1-hour block. */
const DEFAULT_RESERVE = 1;

export class HourlyRateLimiter {
  private timestamps: number[] = [];
  private remaining: number | null = null;
  private limit: number;
  private blockedUntil = 0;

  constructor(
    hourlyLimit = DEFAULT_HOURLY_LIMIT,
    private readonly reserve = DEFAULT_RESERVE,
  ) {
    this.limit = hourlyLimit;
  }

  get info(): FdcRateLimitInfo {
    this.prune(Date.now());
    return {
      limit: this.limit,
      remaining: this.remaining,
      blockedUntil: this.blockedUntil > Date.now() ? new Date(this.blockedUntil) : null,
    };
  }

  acquire(): void {
    const now = Date.now();
    if (now < this.blockedUntil) {
      throw new FdcRateLimitError(
        "USDA FDC API key is blocked after exceeding the hourly rate limit",
        this.blockedUntil - now,
      );
    }

    this.prune(now);
    const localCap = Math.max(0, this.limit - this.reserve);
    const headerBlocked = this.remaining !== null && this.remaining <= this.reserve;
    if (this.timestamps.length >= localCap || headerBlocked) {
      const oldest = this.timestamps[0] ?? now;
      const retryAfterMs = Math.max(oldest + HOUR_MS - now, 1000);
      throw new FdcRateLimitError(
        `USDA FDC hourly rate limit reached (${this.limit} requests/hour). Cached results are still available.`,
        retryAfterMs,
      );
    }

    this.timestamps.push(now);
    if (this.remaining !== null) {
      this.remaining = Math.max(0, this.remaining - 1);
    }
  }

  observeHeaders(headers: Headers): void {
    const limit = parseHeaderNumber(headers.get("x-ratelimit-limit"));
    const remaining = parseHeaderNumber(headers.get("x-ratelimit-remaining"));
    if (limit !== null) {
      this.limit = limit;
    }
    if (remaining !== null) {
      this.remaining = remaining;
    }
  }

  blockFor(retryAfterMs: number): void {
    this.blockedUntil = Date.now() + Math.max(retryAfterMs, 0);
    this.remaining = 0;
  }

  private prune(now: number): void {
    const cutoff = now - HOUR_MS;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
  }
}

export function hourlyLimitForKey(apiKey: string): number {
  return apiKey === "DEMO_KEY" ? DEMO_KEY_HOURLY_LIMIT : DEFAULT_HOURLY_LIMIT;
}

export function parseRetryAfterMs(header: string | null, fallbackMs = HOUR_MS): number {
  if (!header) {
    return fallbackMs;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now());
  }
  return fallbackMs;
}

function parseHeaderNumber(value: string | null): number | null {
  if (value === null || value === "") {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
