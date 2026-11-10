import { describe, expect, it } from "vitest";
import { eatingDayFraction, formatAgo } from "./time.js";

function at(hour: number, minute: number): Date {
  return new Date(2026, 9, 20, hour, minute, 0);
}

describe("eatingDayFraction", () => {
  it("stays at zero until 8:30 am", () => {
    expect(eatingDayFraction(at(7, 0))).toBe(0);
    expect(eatingDayFraction(at(8, 29))).toBe(0);
    expect(eatingDayFraction(at(8, 30))).toBe(0);
  });

  it("reaches one at 10:00 pm and stays there", () => {
    expect(eatingDayFraction(at(22, 0))).toBe(1);
    expect(eatingDayFraction(at(23, 40))).toBe(1);
  });

  it("is halfway at 3:15 pm", () => {
    expect(eatingDayFraction(at(15, 15))).toBeCloseTo(0.5);
  });
});

describe("formatAgo", () => {
  const now = new Date(2026, 10, 9, 18, 0, 0);

  it("says how many days ago a saved graph was made", () => {
    expect(formatAgo(new Date(2026, 10, 7, 9, 0, 0), now)).toBe("2 days ago");
    expect(formatAgo(new Date(2026, 10, 8, 12, 0, 0), now)).toBe("1 day ago");
  });

  it("uses hours on the same day, and a year at the cache limit", () => {
    expect(formatAgo(new Date(2026, 10, 9, 15, 0, 0), now)).toBe("3 hours ago");
    expect(formatAgo(new Date(2026, 10, 9, 17, 59, 40), now)).toBe("just now");
    expect(formatAgo(new Date(2025, 10, 9, 18, 0, 0), now)).toBe("1 year ago");
    expect(formatAgo(new Date(2026, 10, 9, 19, 0, 0), now)).toBe("just now");
  });
});
