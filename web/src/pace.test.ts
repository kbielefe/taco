import { describe, expect, it } from "vitest";
import { paceMeter } from "./pace.js";

describe("paceMeter", () => {
  const range = { minKcal: 2700, maxKcal: 3760 };

  it("puts the range on the right of a scale that ends at the top", () => {
    const meter = paceMeter({ eaten: 852, ...range, dayFraction: 0 });
    expect(meter.scale).toBe(3760);
    expect(meter.rangeStart).toBeCloseTo(2700 / 3760);
    expect(meter.rangeEnd).toBe(1);
    expect(meter.now).toBeCloseTo(852 / 3760);
    expect(meter.day).toBe(0);
  });

  it("places the day mark at that fraction of the middle", () => {
    const meter = paceMeter({ eaten: 852, ...range, dayFraction: 0.5 });
    expect(meter.day).toBeCloseTo((3230 * 0.5) / 3760);
  });

  it("extends the scale when intake is past the top", () => {
    const meter = paceMeter({ eaten: 4000, ...range, dayFraction: 1 });
    expect(meter.scale).toBe(4000);
    expect(meter.now).toBe(1);
    expect(meter.rangeEnd).toBeCloseTo(3760 / 4000);
    expect(meter.day).toBeCloseTo(3230 / 4000);
  });

  it("collapses a single recommendation to one point", () => {
    const meter = paceMeter({ eaten: 500, minKcal: 2000, maxKcal: 2000, dayFraction: 1 });
    expect(meter.rangeStart).toBe(1);
    expect(meter.rangeEnd).toBe(1);
    expect(meter.day).toBe(1);
  });
});