export const ACTIVITY_FACTORS = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  extra: 1.9,
} as const;

export type ActivityLevel = keyof typeof ACTIVITY_FACTORS;
export type Sex = "male" | "female";

export interface BodyProfile {
  birthYear: number;
  sex: Sex;
  heightCm: number;
  activity: ActivityLevel;
}

export type ProfileRead = { ok: true; profile: BodyProfile } | { ok: false; message: string };

const MIN_HEIGHT_CM = 120;
const MAX_HEIGHT_CM = 230;
const MIN_ADULT_AGE = 18;
const MAX_AGE = 120;

export function readBodyProfile(env: NodeJS.ProcessEnv, on: Date): ProfileRead {
  const birth = read(env, "BIRTH_YEAR");
  const sexRaw = read(env, "SEX");
  const inches = read(env, "HEIGHT_IN");
  const centimeters = read(env, "HEIGHT_CM");
  const activityRaw = read(env, "ACTIVITY");

  const missing: string[] = [];
  if (!birth) {
    missing.push("BIRTH_YEAR");
  }
  if (!sexRaw) {
    missing.push("SEX");
  }
  if (!inches && !centimeters) {
    missing.push("HEIGHT_IN or HEIGHT_CM");
  }
  if (missing.length > 0) {
    return { ok: false, message: `Set ${joinList(missing)} in .env.` };
  }

  if (!/^\d{4}$/.test(birth)) {
    return { ok: false, message: "Check BIRTH_YEAR in .env. Use a year." };
  }
  const birthYear = Number(birth);
  const age = on.getUTCFullYear() - birthYear;
  if (age < MIN_ADULT_AGE || age > MAX_AGE) {
    return { ok: false, message: "Check BIRTH_YEAR in .env. This recommendation is for adults." };
  }

  const sex = parseSex(sexRaw);
  if (!sex) {
    return { ok: false, message: "Check SEX in .env. Use male or female." };
  }

  const heightCm = inches ? Number(inches) * 2.54 : Number(centimeters);
  if (!Number.isFinite(heightCm) || heightCm < MIN_HEIGHT_CM || heightCm > MAX_HEIGHT_CM) {
    const name = inches ? "HEIGHT_IN" : "HEIGHT_CM";
    return { ok: false, message: `Check ${name} in .env. Use a height in range.` };
  }

  // Sedentary until a logged week can replace the guess.
  let activity: ActivityLevel = "sedentary";
  if (activityRaw) {
    const parsed = parseActivity(activityRaw);
    if (!parsed) {
      return { ok: false, message: "Check ACTIVITY in .env. Use sedentary, light, moderate, active, or extra." };
    }
    activity = parsed;
  }

  return { ok: true, profile: { birthYear, sex, heightCm, activity } };
}

function read(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function parseSex(value: string): Sex | undefined {
  const key = value.toLowerCase();
  if (key === "male" || key === "m") {
    return "male";
  }
  if (key === "female" || key === "f") {
    return "female";
  }
  return undefined;
}

function parseActivity(value: string): ActivityLevel | undefined {
  const key = value.toLowerCase();
  if (key === "sedentary" || key === "light" || key === "moderate" || key === "active" || key === "extra") {
    return key;
  }
  return undefined;
}

function joinList(items: string[]): string {
  if (items.length === 1) {
    return items[0] ?? "";
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  const last = items[items.length - 1] ?? "";
  return `${items.slice(0, -1).join(", ")}, and ${last}`;
}
