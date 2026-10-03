import { randomBytes } from "node:crypto";

export const SESSION_COOKIE = "taco-session";
export const SESSION_MAX_AGE = 12 * 60 * 60;

const SESSION_ID = /^[a-f0-9]{32}$/;

export function createSessionId(): string {
  return randomBytes(16).toString("hex");
}

export function readSessionId(value: string | undefined): string | undefined {
  const id = value?.trim().toLowerCase();
  return id && SESSION_ID.test(id) ? id : undefined;
}

export function sessionCookieOptions(protocol: string): {
  httpOnly: true;
  sameSite: "Lax";
  path: "/";
  maxAge: number;
  secure: boolean;
} {
  return {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_MAX_AGE,
    secure: protocol === "https:",
  };
}
