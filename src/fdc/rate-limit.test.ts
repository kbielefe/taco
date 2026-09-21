import { describe, expect, it } from "vitest";
import { FdcRateLimitError } from "./errors.js";
import { HourlyRateLimiter, parseRetryAfterMs } from "./rate-limit.js";

describe("HourlyRateLimiter", () => {
  it("allows requests under the hourly cap", () => {
    const limiter = new HourlyRateLimiter(5, 1);
    limiter.acquire();
    limiter.acquire();
    limiter.acquire();
    limiter.acquire();
    expect(() => limiter.acquire()).toThrow(FdcRateLimitError);
  });

  it("honors remaining headers from the API", () => {
    const limiter = new HourlyRateLimiter(1000, 1);
    limiter.observeHeaders(
      new Headers({
        "X-RateLimit-Limit": "1000",
        "X-RateLimit-Remaining": "2",
      }),
    );
    limiter.acquire();
    expect(() => limiter.acquire()).toThrow(FdcRateLimitError);
  });

  it("blocks after a 429 until the retry window elapses", () => {
    const limiter = new HourlyRateLimiter(1000, 1);
    limiter.blockFor(60_000);
    expect(() => limiter.acquire()).toThrow(FdcRateLimitError);
  });
});

describe("parseRetryAfterMs", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  it("falls back when the header is missing", () => {
    expect(parseRetryAfterMs(null, 3_600_000)).toBe(3_600_000);
  });
});
