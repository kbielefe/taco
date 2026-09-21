import { describe, expect, it } from "vitest";
import { readBodyProfile } from "./profile.js";

const on = new Date("2026-09-21T00:00:00.000Z");

describe("readBodyProfile", () => {
  it("reads birth year, sex, and height in inches", () => {
    const read = readBodyProfile({ BIRTH_YEAR: "1980", SEX: " male ", HEIGHT_IN: "70" }, on);
    expect(read).toEqual({
      ok: true,
      profile: { birthYear: 1980, sex: "male", heightCm: 177.8, activity: "sedentary" },
    });
  });

  it("accepts centimeters, a short sex, and an activity", () => {
    const read = readBodyProfile({ BIRTH_YEAR: "1990", SEX: "f", HEIGHT_CM: "162.5", ACTIVITY: "Light" }, on);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.profile.sex).toBe("female");
      expect(read.profile.heightCm).toBe(162.5);
      expect(read.profile.activity).toBe("light");
    }
  });

  it("prefers inches when both heights are set", () => {
    const read = readBodyProfile({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70", HEIGHT_CM: "150" }, on);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.profile.heightCm).toBe(177.8);
    }
  });

  it("names every missing value", () => {
    expect(readBodyProfile({}, on)).toEqual({
      ok: false,
      message: "Set BIRTH_YEAR, SEX, and HEIGHT_IN or HEIGHT_CM in .env.",
    });
    expect(readBodyProfile({ BIRTH_YEAR: "1980", HEIGHT_IN: "70" }, on)).toEqual({
      ok: false,
      message: "Set SEX in .env.",
    });
  });

  it("rejects a bad year, sex, height, activity, or a minor", () => {
    expect(readBodyProfile({ BIRTH_YEAR: "nope", SEX: "male", HEIGHT_IN: "70" }, on).message).toMatch(/year/i);
    expect(readBodyProfile({ BIRTH_YEAR: "2015", SEX: "male", HEIGHT_IN: "70" }, on).message).toMatch(/adults/i);
    expect(readBodyProfile({ BIRTH_YEAR: "1980", SEX: "yes", HEIGHT_IN: "70" }, on).message).toMatch(/male or female/i);
    expect(readBodyProfile({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "10" }, on).message).toMatch(/HEIGHT_IN/);
    expect(readBodyProfile({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_CM: "10" }, on).message).toMatch(/HEIGHT_CM/);
    expect(readBodyProfile({ BIRTH_YEAR: "1980", SEX: "male", HEIGHT_IN: "70", ACTIVITY: "athlete" }, on).message).toMatch(
      /ACTIVITY/,
    );
  });
});
