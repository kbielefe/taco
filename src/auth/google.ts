import { timingSafeEqual } from "node:crypto";
import type { OauthStore } from "./store.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const STATE_MS = 10 * 60 * 1000;

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  allowedEmail: string;
}

export function googleConfigured(env: NodeJS.ProcessEnv): GoogleConfig | undefined {
  const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  const allowedEmail = env.ALLOWED_EMAIL?.trim().toLowerCase() ?? "";
  if (clientId === "" && clientSecret === "" && allowedEmail === "") {
    return undefined;
  }
  if (clientId === "" || clientSecret === "" || allowedEmail === "") {
    throw new Error("GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and ALLOWED_EMAIL must all be set");
  }
  return { clientId, clientSecret, allowedEmail };
}

export function emailsMatch(actual: string, allowed: string): boolean {
  const left = Buffer.from(actual.trim().toLowerCase());
  const right = Buffer.from(allowed.trim().toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function beginGoogleLogin(store: OauthStore, config: GoogleConfig, redirectUri: string, now = new Date()): Promise<string> {
  const state = randomId();
  await store.put({ _id: `google:${state}`, kind: "google-state", expiresAt: new Date(now.getTime() + STATE_MS) });
  const url = new URL(GOOGLE_AUTH);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export async function finishGoogleLogin(input: {
  store: OauthStore;
  config: GoogleConfig;
  code: string;
  state: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<{ ok: true; email: string } | { ok: false; message: string }> {
  const now = input.now ?? new Date();
  const saved = await input.store.get(`google:${input.state}`);
  await input.store.delete(`google:${input.state}`);
  if (!saved || saved.kind !== "google-state") {
    return { ok: false, message: "That sign-in attempt expired. Try again." };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const body = new URLSearchParams({
    code: input.code,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
    redirect_uri: input.redirectUri,
    grant_type: "authorization_code",
  });
  const response = await fetchImpl(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    return { ok: false, message: "Google didn't accept that sign-in. Try again." };
  }
  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) {
    return { ok: false, message: "Google didn't accept that sign-in. Try again." };
  }
  const claims = readIdToken(payload.id_token);
  const email = typeof claims.email === "string" ? claims.email : "";
  const aud = claims.aud;
  const audience = Array.isArray(aud) ? aud : [aud];
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  const iss = claims.iss;
  const verified = claims.email_verified === true;
  const issuerOk = iss === "https://accounts.google.com" || iss === "accounts.google.com";
  if (!issuerOk || !audience.includes(input.config.clientId) || exp * 1000 <= now.getTime() || !verified || email === "") {
    return { ok: false, message: "Google didn't accept that sign-in. Try again." };
  }
  if (!emailsMatch(email, input.config.allowedEmail)) {
    return { ok: false, message: "That Google account can't use Taco." };
  }
  return { ok: true, email: email.trim().toLowerCase() };
}

function readIdToken(idToken: string): Record<string, unknown> {
  const part = idToken.split(".")[1];
  if (!part) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function randomId(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}
