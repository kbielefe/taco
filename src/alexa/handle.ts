import type { OauthStore } from "../auth/store.js";
import { addDays, startOfLocalDay } from "./day.js";
import { readAccessToken } from "./oauth.js";
import { helpText, loggedSpeech, stillLoggingSpeech, todaySpeech, type TodaySnapshot } from "./speech.js";
import { timestampFresh } from "./signature.js";

const REQUEST_MS = 24 * 60 * 60 * 1000;

export interface AlexaDeps {
  skillId: string;
  clientId: string;
  store: OauthStore;
  now?: Date;
  logWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  timeZone: (body: AlexaBody) => Promise<string | null>;
  logMeal: (query: string, eatenAt: Date) => Promise<{ description: string; caloriesKcal: number }>;
  snapshot: (from: Date, to: Date, today: Date) => Promise<TodaySnapshot>;
}

interface AlexaBody {
  request?: {
    type?: string;
    requestId?: string;
    timestamp?: string;
    intent?: { name?: string; slots?: Record<string, { value?: string }> };
  };
  session?: { application?: { applicationId?: string } };
  context?: { System?: { application?: { applicationId?: string }; user?: { accessToken?: string } } };
}

export function skillResponse(text: string, linkAccount = false): Record<string, unknown> {
  return {
    version: "1.0",
    response: {
      outputSpeech: { type: "PlainText", text },
      shouldEndSession: true,
      ...(linkAccount ? { card: { type: "LinkAccount" } } : {}),
    },
  };
}

export async function handleAlexa(body: AlexaBody, deps: AlexaDeps): Promise<{ status: 200 | 400; json: Record<string, unknown> }> {
  const now = deps.now ?? new Date();
  const applicationId = body.session?.application?.applicationId ?? body.context?.System?.application?.applicationId;
  if (applicationId !== deps.skillId || !timestampFresh(body.request?.timestamp, now)) {
    return { status: 400, json: {} };
  }
  const request = body.request;
  if (!request?.type) {
    return { status: 400, json: {} };
  }
  if (request.type === "SessionEndedRequest") {
    return { status: 200, json: skillResponse("") };
  }
  const linked = await readAccessToken(deps.store, body.context?.System?.user?.accessToken, deps.clientId);
  if (!linked) {
    return { status: 200, json: skillResponse("Link Taco in the Alexa app. The code is on the Taco website.", true) };
  }
  if (request.type === "LaunchRequest" || request.intent?.name === "AMAZON.HelpIntent" || request.intent?.name === "AMAZON.FallbackIntent") {
    return { status: 200, json: skillResponse(helpText()) };
  }
  if (request.intent?.name === "AMAZON.StopIntent" || request.intent?.name === "AMAZON.CancelIntent") {
    return { status: 200, json: skillResponse("OK.") };
  }
  const zone = await deps.timeZone(body);
  if (!zone) {
    return { status: 200, json: skillResponse("I couldn't read this device's time zone.") };
  }
  let today: Date;
  try {
    today = startOfLocalDay(now, zone);
  } catch {
    return { status: 200, json: skillResponse("I couldn't read this device's time zone.") };
  }
  const from = today;
  const to = addDays(today, 1);
  if (request.intent?.name === "GetTodayIntent") {
    return { status: 200, json: skillResponse(todaySpeech(await deps.snapshot(from, to, today))) };
  }
  if (request.intent?.name === "LogMealIntent") {
    const query = request.intent.slots?.food?.value?.trim() ?? "";
    if (query === "") {
      return { status: 200, json: skillResponse("Tell me what you ate.") };
    }
    return { status: 200, json: skillResponse(await speakLog(request.requestId, query, from, to, today, deps)) };
  }
  return { status: 200, json: skillResponse(helpText()) };
}

async function speakLog(requestId: string | undefined, query: string, from: Date, to: Date, today: Date, deps: AlexaDeps): Promise<string> {
  const id = `request:${requestId ?? `${query}:${today.toISOString()}`}`;
  const existing = await deps.store.claimRequest(id, new Date((deps.now ?? new Date()).getTime() + REQUEST_MS));
  if (existing?.speech) {
    return existing.speech;
  }
  if (existing) {
    return stillLoggingSpeech(query);
  }
  const waitMs = deps.logWaitMs ?? 6000;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const logged = deps.logMeal(query, deps.now ?? new Date()).then(
    (meal) => ({ ok: true as const, meal }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const winner = await Promise.race([logged, sleep(waitMs).then(() => "timeout" as const)]);
  if (winner === "timeout") {
    void logged.then(async (result) => {
      const speech = result.ok
        ? loggedSpeech(result.meal.description, result.meal.caloriesKcal, await deps.snapshot(from, to, today))
        : "Couldn't log that meal. Try a simpler description.";
      await deps.store.put({ _id: id, kind: "request", expiresAt: new Date(Date.now() + REQUEST_MS), speech });
    });
    return stillLoggingSpeech(query);
  }
  if (!winner.ok) {
    const speech = "Couldn't log that meal. Try a simpler description.";
    await deps.store.put({ _id: id, kind: "request", expiresAt: new Date((deps.now ?? new Date()).getTime() + REQUEST_MS), speech });
    return speech;
  }
  const speech = loggedSpeech(winner.meal.description, winner.meal.caloriesKcal, await deps.snapshot(from, to, today));
  await deps.store.put({ _id: id, kind: "request", expiresAt: new Date((deps.now ?? new Date()).getTime() + REQUEST_MS), speech });
  return speech;
}

export function deviceTimeZone(body: AlexaBody, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const system = (body.context?.System ?? {}) as {
    apiAccessToken?: string;
    device?: { deviceId?: string };
    apiEndpoint?: string;
  };
  const token = system.apiAccessToken;
  const deviceId = system.device?.deviceId;
  if (!token || !deviceId) {
    return Promise.resolve(null);
  }
  const endpoint = system.apiEndpoint ?? "https://api.amazonalexa.com";
  const fetchDevice = fetchImpl ?? fetch;
  return fetchDevice(`${endpoint}/v2/devices/${encodeURIComponent(deviceId)}/settings/System.timeZone`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async (response) => {
    if (!response.ok) {
      return null;
    }
    const text = (await response.text()).trim();
    return text.replace(/^"|"$/g, "") || null;
  });
}
