import { Hono } from "hono";
import { stream, streamSSE } from "hono/streaming";
import { isWeighIn, type CorrectionRunner } from "../correct/run.js";
import { energyWindow, recommendDay } from "../energy/recommend.js";
import { readBodyProfile } from "../energy/profile.js";
import { FdcNetworkError, FdcRateLimitError, FdcServerError, FdcTimeoutError } from "../fdc/errors.js";
import { JournalConflictError, JournalNotFoundError, JournalValidationError } from "../journal/errors.js";
import type { Journal } from "../journal/journal.js";
import { FoodLogAiError, FoodLogConfigError, FoodLogMatchError } from "../log/errors.js";
import type { FoodLogger } from "../log/logger.js";
import type { FoodLogEntry } from "../log/types.js";
import { sumMacros } from "../log/nutrients.js";
import { parseIsoDate, serializeKind, serializeMeal, serializeObservation, type MealJson } from "./serialize.js";
import type { DataCatalog } from "../mcp/catalog.js";
import { handleMcpRequest } from "../mcp/http.js";
import { CATALOG } from "../ask/catalog.js";
import { createXaiAskModel, runAsk, type AskModel } from "../ask/agent.js";
import type { PromptBook } from "../mlflow/prompts.js";
import { AskConfigError, AskFailedError } from "../ask/errors.js";
import { parseAskRequest } from "../ask/request.js";
import { createSyncHub, type SyncHub, type SyncTopic } from "./sync.js";
import { traceRequest } from "./trace.js";

const SYNC_PING_MS = 25_000;

function publicErrorMessage(error: unknown): { message: string; status: 400 | 422 | 500 | 503 } {
  if (error instanceof FoodLogConfigError && /query is required/i.test(error.message)) {
    return { message: "Enter what you ate", status: 400 };
  }
  if (error instanceof FoodLogConfigError && /XAI_API_KEY/i.test(error.message)) {
    return { message: "Couldn't look that up. Set XAI_API_KEY in .env.", status: 503 };
  }
  if (error instanceof FoodLogMatchError) {
    return { message: "Couldn't match that meal. Try a simpler description.", status: 422 };
  }
  if (error instanceof FoodLogAiError) {
    return { message: "Couldn't understand that meal. Try again in a moment.", status: 422 };
  }
  if (isTemporaryFdcFailure(error)) {
    return { message: "The USDA food database is temporarily unavailable. Try again in a moment.", status: 503 };
  }
  return { message: "Something went wrong. Try again.", status: 500 };
}

function isTemporaryFdcFailure(error: unknown): boolean {
  return (
    error instanceof FdcNetworkError ||
    error instanceof FdcTimeoutError ||
    error instanceof FdcServerError ||
    error instanceof FdcRateLimitError
  );
}

export interface AppDeps {
  logger: FoodLogger;
  journal: Journal;
  corrections?: CorrectionRunner;
  env?: NodeJS.ProcessEnv;
  sync?: SyncHub;
  /** Read-only health data. When omitted, POST /mcp and POST /api/ask answer 503. */
  data?: DataCatalog;
  /** Ask model. Tests inject this. The default calls xAI. */
  askModel?: AskModel;
  prompts?: PromptBook;
}

export function createApp({
  logger,
  journal,
  corrections,
  env = process.env,
  sync = createSyncHub(),
  data,
  askModel,
  prompts,
}: AppDeps): Hono {
  const presentMeal = async (entry: FoodLogEntry): Promise<MealJson> => {
    const fit = corrections ? await corrections.current() : null;
    return serializeMeal(entry, fit);
  };
  const publish = (topic: SyncTopic): void => {
    sync.publish(topic);
  };
  const publishFit = (timeZone: string | undefined): void => {
    if (!corrections) {
      return;
    }
    corrections.schedule(timeZone ? { timeZone } : {});
    void corrections.whenIdle().then(() => {
      publish("food");
    });
  };
  const app = new Hono();
  app.use("*", traceRequest);

  app.onError((error, c) => {
    console.error(error);
    const mapped = publicErrorMessage(error);
    return c.json({ error: { message: mapped.message } }, mapped.status);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.all("/mcp", (c) => {
    if (!data) {
      return c.json({ error: { message: "Data access is not configured." } }, 503);
    }
    return handleMcpRequest(c.req.raw, data);
  });

  app.get("/api/events", (c) => {
    c.header("X-Accel-Buffering", "no");
    return streamSSE(c, async (out) => {
      let chain = Promise.resolve();
      const unsubscribe = sync.subscribe((topic) => {
        chain = chain
          .then(async () => {
            await out.writeSSE({ data: JSON.stringify({ topic }) });
          })
          .catch(() => undefined);
      });
      const ping = setInterval(() => {
        chain = chain
          .then(async () => {
            await out.write(":\n\n");
          })
          .catch(() => undefined);
      }, SYNC_PING_MS);
      await new Promise<void>((resolve) => {
        out.onAbort(() => {
          clearInterval(ping);
          unsubscribe();
          resolve();
        });
      });
    });
  });

  app.get("/api/meals", async (c) => {
    const from = parseIsoDate(c.req.query("from"));
    const to = parseIsoDate(c.req.query("to"));
    if (!from || !to) {
      return c.json({ error: { message: "from and to are required ISO dates" } }, 400);
    }
    const meals = await logger.list(from, to);
    const fit = corrections ? await corrections.current() : null;
    return c.json({
      meals: meals.map((meal) => serializeMeal(meal, fit)),
      totals: sumMacros(meals.map((meal) => meal.macros)),
      ...(corrections?.pending() ? { correctionPending: true } : {}),
    });
  });

  app.post("/api/meals", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Enter what you ate" } }, 400);
    }
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const query = typeof record.query === "string" ? record.query : "";
    const eatenAt = typeof record.eatenAt === "string" ? parseIsoDate(record.eatenAt) : undefined;
    const logOptions = eatenAt ? { eatenAt } : {};

    if (!wantsProgressStream(c.req.header("accept"))) {
      try {
        const entry = await logger.log(query, logOptions);
        const meal = await presentMeal(entry);
        publish("food");
        return c.json(meal, 201);
      } catch (error) {
        const mapped = publicErrorMessage(error);
        if (mapped.status === 500) {
          throw error;
        }
        if (mapped.status === 503) {
          console.error(error);
        }
        return c.json({ error: { message: mapped.message } }, mapped.status);
      }
    }

    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (out) => {
      try {
        const entry = await logger.log(query, {
          ...logOptions,
          onProgress: async (message) => {
            await out.writeln(JSON.stringify({ type: "progress", message }));
          },
        });
        await out.writeln(JSON.stringify({ type: "result", meal: await presentMeal(entry) }));
        publish("food");
      } catch (error) {
        const mapped = publicErrorMessage(error);
        if (mapped.status >= 500) {
          console.error(error);
        }
        await out.writeln(JSON.stringify({ type: "error", error: { message: mapped.message }, status: mapped.status }));
      }
    });
  });

  app.delete("/api/meals/:id", async (c) => {
    const deleted = await logger.delete(c.req.param("id"));
    if (!deleted) {
      return c.body(null, 404);
    }
    publish("food");
    return c.body(null, 204);
  });

  app.get("/api/suggestions", async (c) => {
    const suggestions = await logger.suggest(c.req.query("q") ?? "");
    return c.json({ suggestions });
  });

  app.get("/api/recommendation", async (c) => {
    const today = parseIsoDate(c.req.query("today"));
    if (!today) {
      return c.json({ error: { message: "today is a required ISO date" } }, 400);
    }
    const range = energyWindow(today);
    const [meals, observations] = await Promise.all([
      logger.list(range.from, today),
      journal.list(range.historyFrom, range.until),
    ]);
    return c.json(
      recommendDay({
        profile: readBodyProfile(env, today),
        today,
        intakes: meals.map((meal) => ({ eatenAt: meal.eatenAt, kcal: meal.macros.caloriesKcal })),
        observations: observations.map((view) => ({
          at: view.observation.at,
          kindLabel: view.kind.label,
          fields: view.kind.fields,
          values: view.observation.values,
        })),
      }),
    );
  });

  app.get("/api/journal/kinds", async (c) => {
    const kinds = await journal.kinds();
    return c.json({ kinds: kinds.map(serializeKind) });
  });

  app.post("/api/journal/kinds/:id", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return c.json({ error: { message: "Nothing to add." } }, 400);
    }
    try {
      await journal.append(c.req.param("id"), { addFields: body.addFields, addOptions: body.addOptions });
      const kinds = await journal.kinds();
      const view = kinds.find((item) => item.kind._id.toHexString() === c.req.param("id"));
      if (!view) {
        return c.json({ error: { message: "That kind wasn't found." } }, 404);
      }
      publish("journal");
      return c.json(serializeKind(view));
    } catch (error) {
      const mapped = journalHttpError(error);
      if (!mapped) {
        throw error;
      }
      return c.json({ error: { message: mapped.message } }, mapped.status);
    }
  });

  app.get("/api/journal", async (c) => {
    const from = parseIsoDate(c.req.query("from"));
    const to = parseIsoDate(c.req.query("to"));
    if (!from || !to) {
      return c.json({ error: { message: "from and to are required ISO dates" } }, 400);
    }
    const observations = await journal.list(from, to);
    return c.json({ observations: observations.map(serializeObservation) });
  });

  app.post("/api/journal", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return c.json({ error: { message: "Choose what you're recording." } }, 400);
    }
    let at: Date | undefined;
    if (body.at !== undefined) {
      if (typeof body.at !== "string") {
        return c.json({ error: { message: "That time isn't valid." } }, 400);
      }
      at = parseIsoDate(body.at);
      if (!at) {
        return c.json({ error: { message: "That time isn't valid." } }, 400);
      }
    }
    const kindId = typeof body.kindId === "string" && body.kindId ? body.kindId : undefined;
    const kind = kindId ? undefined : readKind(body.kind);
    try {
      const view = await journal.log({
        ...(kindId ? { kindId } : {}),
        ...(kind ? { kind } : {}),
        ...(at ? { at } : {}),
        values: body.values,
      });
      publish("journal");
      if (isWeighIn(view)) {
        publishFit(typeof body.timeZone === "string" ? body.timeZone : undefined);
      }
      return c.json(serializeObservation(view), 201);
    } catch (error) {
      const mapped = journalHttpError(error);
      if (!mapped) {
        throw error;
      }
      return c.json({ error: { message: mapped.message } }, mapped.status);
    }
  });

  app.get("/a2ui/taco/v1/catalog.json", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.json(CATALOG);
  });

  app.post("/api/ask", async (c) => {
    const body = await readJson(c);
    if (!body) {
      return c.json({ error: { message: "Enter a question." } }, 400);
    }
    const request = parseAskRequest(body);
    if (!request.ok) {
      return c.json({ error: { message: request.message } }, request.status);
    }
    if (!data) {
      return c.json({ error: { message: "The health data isn't connected." } }, 503);
    }
    let model = askModel;
    if (!model) {
      try {
        model = createXaiAskModel({ env });
      } catch (error) {
        if (error instanceof AskConfigError) {
          return c.json({ error: { message: error.message } }, 503);
        }
        throw error;
      }
    }

    c.header("Content-Type", "application/x-ndjson; charset=utf-8");
    c.header("Cache-Control", "no-cache");
    c.header("X-Accel-Buffering", "no");
    return stream(c, async (out) => {
      try {
        await runAsk({
          question: request.question,
          timeZone: request.timeZone,
          today: request.today,
          history: request.history,
          data,
          model,
          ...(prompts ? { prompts } : {}),
          emit: async (event) => {
            await out.writeln(JSON.stringify(event));
          },
        });
        await out.writeln(JSON.stringify({ type: "done" }));
      } catch (error) {
        const mapped = askHttpError(error);
        if (mapped.status === 500) {
          console.error(error);
        }
        await out.writeln(JSON.stringify({ type: "error", error: { message: mapped.message }, status: mapped.status }));
      }
    });
  });

  app.delete("/api/journal/:id", async (c) => {
    const id = c.req.param("id");
    const existing = await journal.get(id);
    const deleted = await journal.delete(id);
    if (!deleted) {
      return c.body(null, 404);
    }
    publish("journal");
    if (existing && isWeighIn(existing)) {
      publishFit(c.req.query("timeZone"));
    }
    return c.body(null, 204);
  });

  return app;
}

function askHttpError(error: unknown): { message: string; status: 422 | 500 | 503 } {
  if (error instanceof AskConfigError) {
    return { message: error.message, status: 503 };
  }
  if (error instanceof AskFailedError) {
    return { message: error.message, status: 422 };
  }
  return { message: "Couldn't answer that. Try again in a moment.", status: 500 };
}

function journalHttpError(error: unknown): { message: string; status: 400 | 404 | 409 } | undefined {
  if (error instanceof JournalValidationError) {
    return { message: error.message, status: 400 };
  }
  if (error instanceof JournalNotFoundError) {
    return { message: error.message, status: 404 };
  }
  if (error instanceof JournalConflictError) {
    return { message: error.message, status: 409 };
  }
  return undefined;
}

function readKind(raw: unknown): { label: unknown; fields: unknown } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  return { label: record.label, fields: record.fields };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return undefined;
    }
    return body as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function wantsProgressStream(accept: string | undefined): boolean {
  return (accept ?? "").includes("application/x-ndjson");
}
