import { describe, expect, it } from "vitest";
import type { BodyProfile, ProfileRead } from "./profile.js";
import { DAY_MS, recommendDay, type IntakeSample, type WeightObservation } from "./recommend.js";

const today = new Date("2026-09-21T00:00:00.000Z");
const from = new Date(today.getTime() - 7 * DAY_MS);

function profile(overrides: Partial<BodyProfile> = {}): ProfileRead {
  return {
    ok: true,
    profile: {
      birthYear: 1980,
      sex: "male",
      heightCm: 70 * 2.54,
      activity: "sedentary",
      ...overrides,
    },
  };
}

function weight(at: Date, value: number, unit = "lb", kindLabel = "weight"): WeightObservation {
  return {
    at,
    kindLabel,
    fields: [{ id: "weight", label: "weight", type: "number", unit }],
    values: [{ fieldId: "weight", value }],
  };
}

function meals(kcal: number, days: number[]): IntakeSample[] {
  return days.map((day) => ({
    eatenAt: new Date(from.getTime() + day * DAY_MS + 12 * 60 * 60 * 1000),
    kcal,
  }));
}

describe("recommendDay", () => {
  it("cuts 1,000 kcal from a sedentary estimate and stops at the male minimum", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(new Date("2026-09-20T12:00:00.000Z"), 220)],
    });
    expect(result.kcal).toBe(1500);
    expect(result.minKcal).toBe(1500);
    expect(result.maxKcal).toBe(1500);
    expect(result.goal).toBe("lose");
    expect(result.basis).toBe("body");
    expect(result.limitedByMinimum).toBe(true);
    expect(result.minimumKcal).toBe(1500);
    expect(result.bmi).toBe(31.6);
    expect(result.message).toBe(
      "Aiming to lose 2 lb a week, from your body size, held at 1,500 kcal, a safe minimum. A few weeks of food and weight will refine this.",
    );
  });

  it("holds weight when BMI is in the healthy range", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(today, 160)],
    });
    expect(result).toMatchObject({
      kcal: 1930,
      minKcal: 1930,
      maxKcal: 1930,
      goal: "maintain",
      basis: "body",
      limitedByMinimum: false,
      bmi: 23,
    });
    expect(result.message).toMatch(/Holding your weight/);
    expect(result.message).toMatch(/healthy range/);
    expect(result.message).not.toMatch(/below/);
  });

  it("does not aim for a loss when BMI is below the healthy range", () => {
    const result = recommendDay({
      profile: profile({ sex: "female", birthYear: 1980 }),
      today,
      intakes: [],
      observations: [weight(today, 110)],
    });
    expect(result).toMatchObject({ kcal: 1460, goal: "maintain", bmi: 15.8, minimumKcal: 1200 });
    expect(result.message).toMatch(/below the healthy range/);
  });

  it("holds a small deficit target at the female minimum", () => {
    const result = recommendDay({
      profile: profile({ sex: "female", birthYear: 1956, heightCm: 58 * 2.54 }),
      today,
      intakes: [],
      observations: [weight(today, 200)],
    });
    expect(result).toMatchObject({ kcal: 1200, goal: "lose", limitedByMinimum: true, minimumKcal: 1200 });
    expect(result.message).toMatch(/1,200 kcal/);
  });

  it("uses a higher activity factor from the profile", () => {
    const result = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: [],
      observations: [weight(today, 220)],
    });
    expect(result.kcal).toBe(1590);
    expect(result.minKcal).toBe(1500);
    expect(result.maxKcal).toBe(1680);
    expect(result.limitedByMinimum).toBe(false);
    expect(result.message).toMatch(/about 1,590 kcal/);
    expect(result.message).toMatch(/too fast/);
  });

  it("nudges today's range after a day near the bottom", () => {
    const result = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: meals(1500, [3]),
      observations: [weight(today, 220)],
    });
    expect(result).toMatchObject({ minKcal: 1510, kcal: 1600, maxKcal: 1690 });
    expect(result.message).not.toMatch(/a little higher/);
  });

  it("nudges today's range after a day near the top", () => {
    const result = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: meals(1680, [3]),
      observations: [weight(today, 220)],
    });
    expect(result).toMatchObject({ minKcal: 1500, kcal: 1580, maxKcal: 1670 });
  });

  it("moves the range by one day's gap after a week at the bottom", () => {
    const result = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: meals(1500, [0, 1, 2, 3, 4, 5, 6]),
      observations: [weight(today, 220)],
    });
    expect(result).toMatchObject({ minKcal: 1590, kcal: 1680, maxKcal: 1770 });
    expect(result.message).toMatch(/a little higher/);
    expect(result.message).toMatch(/too fast/);
  });

  it("ignores a day under 800 kcal and does not turn a low week into a feast", () => {
    const ignored = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: meals(400, [0, 1, 2, 3, 4, 5, 6]),
      observations: [weight(today, 220)],
    });
    expect(ignored).toMatchObject({ minKcal: 1500, kcal: 1590, maxKcal: 1680 });

    const raised = recommendDay({
      profile: profile({ activity: "light" }),
      today,
      intakes: meals(800, [0, 1, 2, 3, 4, 5, 6]),
      observations: [weight(today, 220)],
    });
    expect(raised).toMatchObject({ minKcal: 2290, kcal: 2380, maxKcal: 2470 });
    expect(raised.message).toMatch(/a little higher/);
    expect(raised.message).not.toMatch(/catch-up day/);
  });

  it("moves the next day by about a seventh of one day's miss", () => {
    const observations = [weight(today, 313)];
    const base = recommendDay({ profile: profile(), today, intakes: [], observations });
    const after = recommendDay({
      profile: profile(),
      today,
      intakes: meals(base.kcal! + 1000, [3]),
      observations,
    });
    expect(base).toMatchObject({ minKcal: 1500, kcal: 1770, maxKcal: 2040 });
    expect(after).toMatchObject({ minKcal: 1500, kcal: 1630, maxKcal: 1900 });
    expect(base.kcal! - after.kcal!).toBe(140);
  });

  it("keeps the range when a weigh-in leaves the last 7 days", () => {
    const steady = (dayShift: number) => {
      const on = new Date(today.getTime() + dayShift * DAY_MS);
      const observations = [-22, -15, -8, -3, -1].map((day) => weight(new Date(today.getTime() + day * DAY_MS), 160));
      const intakes = [];
      for (let day = -26; day < dayShift; day += 1) {
        intakes.push({ eatenAt: new Date(today.getTime() + day * DAY_MS + 12 * 60 * 60 * 1000), kcal: 2730 });
      }
      return recommendDay({ profile: profile(), today: on, intakes, observations });
    };
    const earlier = steady(0);
    const later = steady(2);
    expect(earlier).toMatchObject({ kcal: 2290, minKcal: 2290, maxKcal: 2290, goal: "maintain", basis: "partial" });
    expect(later.kcal).toBe(earlier.kcal);
    expect(later.minKcal).toBe(earlier.minKcal);
    expect(later.maxKcal).toBe(earlier.maxKcal);
  });

  it("reads pounds and kilograms, and ignores other journal entries", () => {
    const pounds = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(today, 220, "pounds")],
    });
    const kilos = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(today, 100, "kg", "Body weight")],
    });
    expect(pounds.kcal).toBe(1500);
    expect(kilos.goal).toBe("lose");
    expect(kilos.limitedByMinimum).toBe(true);

    const other = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [
        {
          at: today,
          kindLabel: "Blood pressure",
          fields: [
            { id: "systolic", label: "Systolic", type: "number", unit: "mmHg" },
            { id: "diastolic", label: "Diastolic", type: "number", unit: "mmHg" },
          ],
          values: [
            { fieldId: "systolic", value: 120 },
            { fieldId: "diastolic", value: 80 },
          ],
        },
        weight(today, 30, "lb"),
      ],
    });
    expect(other.kcal).toBeNull();
    expect(other.message).toMatch(/Log a weight/);
  });

  it("uses an older weight when nothing was logged this week", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(new Date(today.getTime() - 30 * DAY_MS), 160)],
    });
    expect(result.kcal).toBe(1930);
    expect(result.basis).toBe("body");
  });

  it("ignores a weight older than a year", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: [],
      observations: [weight(new Date(today.getTime() - 366 * DAY_MS), 220)],
    });
    expect(result.kcal).toBeNull();
  });

  it("estimates expenditure from a full week of food and weight change", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: [
        ...meals(2500, [0, 1, 2, 3, 4, 5, 6]),
        { eatenAt: new Date(today.getTime() + 60 * 60 * 1000), kcal: 9000 },
      ],
      observations: [weight(from, 220), weight(today, 219)],
    });
    expect(result).toMatchObject({
      kcal: 1500,
      minKcal: 1500,
      maxKcal: 1500,
      goal: "lose",
      basis: "partial",
      limitedByMinimum: true,
    });
    expect(result.message).toBe(
      "Aiming to lose 2 lb a week, partly from recent weigh-ins, held at 1,500 kcal, a safe minimum. The previous days were over that pace.",
    );
  });

  it("blends a partial week with the body-size estimate", () => {
    const result = recommendDay({
      profile: profile(),
      today,
      intakes: meals(2500, [0, 2, 4]),
      observations: [weight(from, 220), weight(today, 219)],
    });
    expect(result).toMatchObject({ kcal: 1500, minKcal: 1500, maxKcal: 1500, basis: "partial", goal: "lose" });
    expect(result.message).toMatch(/partly from recent weigh-ins/);
    expect(result.message).toMatch(/1,500 kcal/);
  });

  it("does not let an under-logged week sink the target", () => {
    const result = recommendDay({
      profile: profile({ birthYear: 2005, heightCm: 78 * 2.54 }),
      today,
      intakes: meals(400, [0, 1, 2, 3, 4, 5, 6]),
      observations: [weight(from, 210), weight(today, 210)],
    });
    expect(result).toMatchObject({ kcal: 2350, goal: "maintain", basis: "partial", limitedByMinimum: false });
    expect(result.kcal).toBeGreaterThan(2000);
  });

  it("passes a profile problem through", () => {
    const result = recommendDay({
      profile: { ok: false, message: "Set BIRTH_YEAR in .env." },
      today,
      intakes: [],
      observations: [weight(today, 180)],
    });
    expect(result.kcal).toBeNull();
    expect(result.minKcal).toBeNull();
    expect(result.maxKcal).toBeNull();
    expect(result.message).toBe("Set BIRTH_YEAR in .env.");
  });
});
