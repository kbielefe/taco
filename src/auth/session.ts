import type { OauthRecord, OauthStore } from "./store.js";
import { randomId } from "./google.js";

export const SESSION_COOKIE = "taco_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export async function createSession(store: OauthStore, email: string, now = new Date()): Promise<string> {
  const id = randomId();
  await store.put({
    _id: `session:${id}`,
    kind: "session",
    email,
    expiresAt: new Date(now.getTime() + SESSION_MS),
  });
  return id;
}

export async function readSession(store: OauthStore, cookieValue: string | undefined): Promise<OauthRecord | null> {
  if (!cookieValue) {
    return null;
  }
  const record = await store.get(`session:${cookieValue}`);
  if (!record || record.kind !== "session" || !record.email) {
    return null;
  }
  return record;
}

export function sessionCookie(id: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MS / 1000}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}
