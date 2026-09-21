import { ACTIVITY_FACTORS, type BodyProfile } from "../energy/profile.js";

/** Mifflin-St Jeor times the activity factor, matching the daily recommendation. */
export function formulaPerDay(weightKg: number, profile: BodyProfile, year: number): number {
  const age = year - profile.birthYear;
  const sexOffset = profile.sex === "male" ? 5 : -161;
  const bmr = 10 * weightKg + 6.25 * profile.heightCm - 5 * age + sexOffset;
  return bmr * ACTIVITY_FACTORS[profile.activity];
}
