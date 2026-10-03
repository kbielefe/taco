import { describe, expect, it, vi } from "vitest";
import { MemoryOauthStore } from "../auth/store.js";
import { handleAlexa } from "../alexa/handle.js";
import { createLinkCode } from "../alexa/oauth.js";
import { signatureCertUrlAllowed, timestampFresh } from "../alexa/signature.js";
import { finishGoogleLogin } from "../auth/google.js";
import { createApp } from "./routes.js";
import { FoodLogger } from "../log/logger.js";
import { MemoryFoodStore } from "../log/store.js";
import { MemoryCacheStore } from "../fdc/cache.js";
import { Journal } from "../journal/journal.js";
import { MemoryJournalStore } from "../journal/store.js";
import type { FoodLogAi, ParsedMeal, SelectMatchInput, SelectedMatch } from "../log/types.js";
import type { SearchResult, SearchResultFood, FoodItem } from "../fdc/types.js";

const google = { clientId: "google-client", clientSecret: "google-secret", allowedEmail: "me@example.com" };
const alexa = { skillId: "amzn1.ask.skill.test", clientId: "alexa-client", clientSecret: "alexa-secret" };
const redirect = "https://pitangui.amazon.com/api/skill/link/ABC";

function idToken(claims: Record<string, unknown>): string {
  return `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`;
}

function mealApp(store = new MemoryOauthStore()) {
  const food = (overrides: Partial<SearchResultFood> & Pick<SearchResultFood, "fdcId" | "description">): SearchResultFood => ({
    dataType: "SR Legacy",
    score: 100,
    ...overrides,
  });
  const details = (calories: number): FoodItem => ({
    fdcId: 1,
    dataType: "SR Legacy",
    description: "Bananas, raw",
    foodNutrients: [
      { amount: calories, nutrient: { id: 1008, number: "208", name: "Energy", unitName: "KCAL" } },
      { amount: 1, nutrient: { id: 1003, number: "203", name: "Protein", unitName: "G" } },
      { amount: 0, nutrient: { id: 1004, number: "204", name: "Total lipid (fat)", unitName: "G" } },
      { amount: 20, nutrient: { id: 1005, number: "205", name: "Carbohydrate, by difference", unitName: "G" } },
      { amount: 2, nutrient: { id: 1079, number: "291", name: "Fiber, total dietary", unitName: "G" } },
    ],
  });
  const ai: FoodLogAi = {
    parseQuery: vi.fn(async () => ({ items: [{ name: "banana", searchQueries: ["banana"], servingHint: "1 banana", quantity: 1 }] }) satisfies ParsedMeal),
    selectMatch: vi.fn(async (_input: SelectMatchInput) => ({ fdcId: 1, grams: 100, servingDescription: "100 g" }) satisfies SelectedMatch),
  };
  const logger = new FoodLogger({
    fdc: {
      searchFoods: vi.fn(async () => ({ foods: [food({ fdcId: 1, description: "Bananas, raw" })] }) satisfies SearchResult),
      getFood: vi.fn(async () => details(89)),
    },
    ai,
    queryCache: new MemoryCacheStore(),
    foodStore: new MemoryFoodStore(),
  });
  const app = createApp({
    logger,
    journal: new Journal(new MemoryJournalStore()),
    login: { google, alexa, store },
    alexaVerify: async () => true,
    alexaTimeZone: async () => "UTC",
    alexaNow: () => new Date("2026-10-02T15:00:00.000Z"),
  });
  return { app, store, logger };
}

describe("google login", () => {
  it("rejects a different email", async () => {
    const store = new MemoryOauthStore();
    await store.put({ _id: "google:state", kind: "google-state", expiresAt: new Date(Date.now() + 60_000) });
    const result = await finishGoogleLogin({
      store,
      config: google,
      code: "code",
      state: "state",
      redirectUri: "http://127.0.0.1/oauth/google/callback",
      fetchImpl: async () =>
        new Response(JSON.stringify({ id_token: idToken({ iss: "https://accounts.google.com", aud: google.clientId, exp: Math.floor(Date.now() / 1000) + 60, email: "other@example.com", email_verified: true }) })),
    });
    expect(result).toEqual({ ok: false, message: "That Google account can't use Taco." });
  });

  it("requires a session for meals", async () => {
    const { app } = mealApp();
    const res = await app.request("/api/meals?from=2026-10-02T00:00:00.000Z&to=2026-10-03T00:00:00.000Z");
    expect(res.status).toBe(401);
    const health = await app.request("/api/health");
    expect(health.status).toBe(200);
  });
});

describe("alexa linking", () => {
  it("rejects the wrong client and a bad signature", async () => {
    const { app, store } = mealApp();
    const link = await createLinkCode(store, google.allowedEmail);
    const denied = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: "nope", client_id: "other", client_secret: "alexa-secret", redirect_uri: redirect }),
    });
    expect(denied.status).toBe(401);

    const page = await app.request("/oauth/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: alexa.clientId, redirect_uri: redirect, state: "xyz", code: link }),
    });
    expect(page.status).toBe(302);
    const issued = new URL(page.headers.get("location") ?? "");
    const tokens = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: issued.searchParams.get("code") ?? "",
        client_id: alexa.clientId,
        client_secret: alexa.clientSecret,
        redirect_uri: redirect,
      }),
    });
    expect(tokens.status).toBe(200);
    const first = (await tokens.json()) as { access_token: string; refresh_token: string };
    const refreshed = await app.request("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: alexa.clientId,
        client_secret: "wrong",
      }),
    });
    expect(refreshed.status).toBe(401);

    const open = createApp({
      logger: new FoodLogger({
        fdc: { searchFoods: async () => ({ foods: [] }), getFood: async () => { throw new Error("unused"); } },
        ai: { parseQuery: async () => ({ items: [] }), selectMatch: async () => ({ fdcId: 1, grams: 1, servingDescription: "1" }) },
        queryCache: new MemoryCacheStore(),
        foodStore: new MemoryFoodStore(),
      }),
      journal: new Journal(new MemoryJournalStore()),
      login: { google, alexa, store },
    });
    const unsigned = await open.request("/api/alexa", { method: "POST", body: "{}" });
    expect(unsigned.status).toBe(400);
    expect(signatureCertUrlAllowed("http://s3.amazonaws.com/echo.api/cert")).toBe(false);
    expect(signatureCertUrlAllowed("https://s3.amazonaws.com/echo.api/cert.pem")).toBe(true);
    expect(timestampFresh("2026-10-02T15:00:00.000Z", new Date("2026-10-02T15:00:30.000Z"))).toBe(true);
    expect(timestampFresh("2026-10-02T14:00:00.000Z", new Date("2026-10-02T15:00:00.000Z"))).toBe(false);
  });
});

describe("alexa speech", () => {
  const now = new Date("2026-10-02T15:00:00.000Z");

  function request(intent: string, accessToken?: string, food?: string) {
    return {
      request: {
        type: "IntentRequest",
        requestId: "req-1",
        timestamp: now.toISOString(),
        intent: { name: intent, slots: food ? { food: { value: food } } : {} },
      },
      session: { application: { applicationId: alexa.skillId } },
      context: { System: { user: { accessToken } } },
    };
  }

  it("asks for account linking and then speaks today", async () => {
    const store = new MemoryOauthStore();
    const snapshot = vi.fn(async () => ({ caloriesKcal: 89, proteinG: 1.2, fatG: 0.2, carbG: 23, fiberG: 2.6, minKcal: 1500, maxKcal: 1800 }));
    const unlinked = await handleAlexa(request("GetTodayIntent"), {
      skillId: alexa.skillId,
      clientId: alexa.clientId,
      store,
      now,
      timeZone: async () => "UTC",
      logMeal: async () => ({ description: "Bananas, raw", caloriesKcal: 89 }),
      snapshot,
    });
    expect(JSON.stringify(unlinked.json)).toContain("LinkAccount");

    await store.put({ _id: "access:token", kind: "access", clientId: alexa.clientId, email: google.allowedEmail, expiresAt: new Date("2099-01-01T00:00:00.000Z") });
    const today = await handleAlexa(request("GetTodayIntent", "token"), {
      skillId: alexa.skillId,
      clientId: alexa.clientId,
      store,
      now,
      timeZone: async () => "UTC",
      logMeal: async () => ({ description: "Bananas, raw", caloriesKcal: 89 }),
      snapshot,
    });
    const text = JSON.stringify(today.json);
    expect(text).toContain("89 calories");
    expect(text).toContain("1411 to 1711 left");
  });

  it("logs once when the lookup is slow", async () => {
    const store = new MemoryOauthStore();
    await store.put({ _id: "access:token", kind: "access", clientId: alexa.clientId, email: google.allowedEmail, expiresAt: new Date("2099-01-01T00:00:00.000Z") });
    let calls = 0;
    let finish: (meal: { description: string; caloriesKcal: number }) => void = () => {};
    const pending = handleAlexa(request("LogMealIntent", "token", "a banana"), {
      skillId: alexa.skillId,
      clientId: alexa.clientId,
      store,
      now,
      logWaitMs: 5,
      sleep: async () => {},
      timeZone: async () => "UTC",
      logMeal: () => {
        calls += 1;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      snapshot: async () => ({ caloriesKcal: 89, proteinG: 1, fatG: 0, carbG: 20, fiberG: 2, minKcal: null, maxKcal: null }),
    });
    const first = await pending;
    expect(JSON.stringify(first.json)).toContain("I'm logging a banana");
    const again = await handleAlexa(request("LogMealIntent", "token", "a banana"), {
      skillId: alexa.skillId,
      clientId: alexa.clientId,
      store,
      now,
      logWaitMs: 5,
      sleep: async () => {},
      timeZone: async () => "UTC",
      logMeal: () => {
        calls += 1;
        return Promise.resolve({ description: "Bananas, raw", caloriesKcal: 89 });
      },
      snapshot: async () => ({ caloriesKcal: 89, proteinG: 1, fatG: 0, carbG: 20, fiberG: 2, minKcal: null, maxKcal: null }),
    });
    expect(JSON.stringify(again.json)).toContain("I'm logging a banana");
    expect(calls).toBe(1);
    finish({ description: "Bananas, raw", caloriesKcal: 89 });
    await vi.waitFor(async () => {
      const saved = await store.get("request:req-1");
      expect(saved?.speech).toContain("Logged Bananas, raw");
    });
  });

  it("speaks a fast log", async () => {
    const { app, store } = mealApp();
    await store.put({ _id: "access:tok", kind: "access", clientId: alexa.clientId, email: google.allowedEmail, expiresAt: new Date("2099-01-01T00:00:00.000Z") });
    const body = {
      request: { type: "IntentRequest", requestId: "fast-1", timestamp: "2026-10-02T15:00:00.000Z", intent: { name: "LogMealIntent", slots: { food: { value: "a banana" } } } },
      session: { application: { applicationId: alexa.skillId } },
      context: { System: { user: { accessToken: "tok" } } },
    };
    const res = await app.request("/api/alexa", { method: "POST", body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    const text = JSON.stringify(await res.json());
    expect(text).toContain("Logged banana (100 g), 89 calories");
    expect(text).toContain("89");
  });
});
