import { describe, expect, it } from "vitest";
import { eatingDayFraction } from "./time.js";

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
