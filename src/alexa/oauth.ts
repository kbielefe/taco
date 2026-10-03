import { timingSafeEqual } from "node:crypto";
import { randomId } from "../auth/google.js";
import type { OauthStore } from "../auth/store.js";

const LINK_MS = 10 * 60 * 1000;
const CODE_MS = 60 * 1000;
const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 180 * 24 * 60 * 60 * 1000;
const LINK_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const AMAZON_REDIRECT_HOSTS = new Set(["pitangui.amazon.com", "layla.amazon.com", "alexa.amazon.co.jp"]);

export interface AlexaClientConfig {
  skillId: string;
  clientId: string;
  clientSecret: string;
}

export function alexaConfigured(env: NodeJS.ProcessEnv): AlexaClientConfig | undefined {
  const skillId = env.ALEXA_SKILL_ID?.trim() ?? "";
  const clientId = env.ALEXA_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.ALEXA_CLIENT_SECRET?.trim() ?? "";
  if (skillId === "" && clientId === "" && clientSecret === "") {
    return undefined;
  }
  if (skillId === "" || clientId === "" || clientSecret === "") {
    throw new Error("ALEXA_SKILL_ID, ALEXA_CLIENT_ID, and ALEXA_CLIENT_SECRET must all be set");
  }
  return { skillId, clientId, clientSecret };
}

export function secretsMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function amazonRedirectAllowed(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && AMAZON_REDIRECT_HOSTS.has(url.hostname) && url.pathname.startsWith("/api/skill/link/");
}

export async function createLinkCode(store: OauthStore, email: string, now = new Date()): Promise<string> {
  const code = Array.from({ length: 8 }, () => LINK_ALPHABET[crypto.getRandomValues(new Uint8Array(1))[0]! % LINK_ALPHABET.length]).join("");
  await store.put({ _id: `link:${code}`, kind: "link", email, expiresAt: new Date(now.getTime() + LINK_MS) });
  return code;
}

export async function exchangeLinkCode(input: {
  store: OauthStore;
  linkCode: string;
  clientId: string;
  redirectUri: string;
  now?: Date;
}): Promise<string | undefined> {
  const now = input.now ?? new Date();
  const link = await input.store.get(`link:${input.linkCode.trim().toUpperCase()}`);
  if (!link || link.kind !== "link" || !link.email) {
    return undefined;
  }
  await input.store.delete(link._id);
  const code = randomId();
  await input.store.put({
    _id: `code:${code}`,
    kind: "code",
    email: link.email,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    expiresAt: new Date(now.getTime() + CODE_MS),
  });
  return code;
}

export async function issueTokens(store: OauthStore, email: string, clientId: string, now = new Date()): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: "Bearer" }> {
  const access = randomId();
  const refresh = randomId();
  await store.put({ _id: `access:${access}`, kind: "access", email, clientId, expiresAt: new Date(now.getTime() + ACCESS_MS) });
  await store.put({ _id: `refresh:${refresh}`, kind: "refresh", email, clientId, expiresAt: new Date(now.getTime() + REFRESH_MS) });
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_MS / 1000, token_type: "Bearer" };
}

export async function redeemAuthorizationCode(input: {
  store: OauthStore;
  code: string;
  clientId: string;
  redirectUri: string;
  now?: Date;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: "Bearer" } | undefined> {
  const saved = await input.store.get(`code:${input.code}`);
  if (!saved || saved.kind !== "code" || saved.clientId !== input.clientId || saved.redirectUri !== input.redirectUri || !saved.email) {
    return undefined;
  }
  await input.store.delete(saved._id);
  return issueTokens(input.store, saved.email, input.clientId, input.now);
}

export async function redeemRefreshToken(input: {
  store: OauthStore;
  refreshToken: string;
  clientId: string;
  now?: Date;
}): Promise<{ access_token: string; refresh_token: string; expires_in: number; token_type: "Bearer" } | undefined> {
  const saved = await input.store.get(`refresh:${input.refreshToken}`);
  if (!saved || saved.kind !== "refresh" || saved.clientId !== input.clientId || !saved.email) {
    return undefined;
  }
  await input.store.delete(saved._id);
  return issueTokens(input.store, saved.email, input.clientId, input.now);
}

export async function readAccessToken(store: OauthStore, token: string | undefined, clientId: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  const saved = await store.get(`access:${token}`);
  return Boolean(saved && saved.kind === "access" && saved.clientId === clientId);
}
